#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-ContainerStartSpeedStack}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
SMALL_REQUIREMENTS_FILE="${SMALL_REQUIREMENTS_FILE:-requirements-small.txt}"
LARGE_REQUIREMENTS_FILE="${LARGE_REQUIREMENTS_FILE:-requirements-large.txt}"
ARCHITECTURES="${ARCHITECTURES:-x86_64,arm64}"
WORK_DIR="${WORK_DIR:-.benchmark-build}"
BUILDX_BUILDER="${BUILDX_BUILDER:-container-start-speed}"
SOCI_RUNNER="${SOCI_RUNNER:-docker}"
SOCI_VERSION="${SOCI_VERSION:-0.14.0}"
SOCI_IMAGE="${SOCI_IMAGE:-container-start-speed-soci:${SOCI_VERSION}}"
SOCI_DOCKER_PLATFORM="${SOCI_DOCKER_PLATFORM:-$(case "$(uname -m)" in arm64|aarch64) echo linux/arm64 ;; *) echo linux/amd64 ;; esac)}"
SOCI_DOCKER_PRIVILEGED="${SOCI_DOCKER_PRIVILEGED:-1}"

if [[ -z "${REGION}" ]]; then
  REGION="$(aws configure get region)"
fi

if [[ -z "${REGION}" ]]; then
  echo "Set AWS_REGION or configure a default AWS CLI region." >&2
  exit 1
fi

if [[ "${SOCI_RUNNER}" == "docker" && "${WORK_DIR}" = /* ]]; then
  echo "When SOCI_RUNNER=docker, WORK_DIR must be relative to the repository so it can be mounted into the SOCI container." >&2
  exit 1
fi

REPOSITORY_URI="${REPOSITORY_URI:-$(aws cloudformation describe-stacks \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue | [0]" \
  --output text)}"

if [[ -z "${REPOSITORY_URI}" || "${REPOSITORY_URI}" == "None" ]]; then
  echo "Could not resolve RepositoryUri from stack ${STACK_NAME}." >&2
  exit 1
fi

command -v docker >/dev/null || { echo "docker is required." >&2; exit 1; }
command -v aws >/dev/null || { echo "aws CLI is required." >&2; exit 1; }
command -v crane >/dev/null || { echo "crane is required for OCI archive pushes." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

REGISTRY="${REPOSITORY_URI%/*}"
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"
aws ecr get-login-password --region "${REGION}" | crane auth login "${REGISTRY}" --username AWS --password-stdin

mkdir -p "${WORK_DIR}"

ensure_buildx_builder() {
  if docker buildx inspect "${BUILDX_BUILDER}" >/dev/null 2>&1; then
    docker buildx inspect "${BUILDX_BUILDER}" --bootstrap >/dev/null
    return
  fi

  echo "Creating Buildx builder ${BUILDX_BUILDER} with docker-container driver"
  docker buildx create \
    --name "${BUILDX_BUILDER}" \
    --driver docker-container \
    --bootstrap \
    --use >/dev/null
}

ensure_soci_runner() {
  if [[ "${SOCI_RUNNER}" == "local" ]]; then
    command -v soci >/dev/null || { echo "soci CLI is required when SOCI_RUNNER=local." >&2; exit 1; }
    return
  fi

  if [[ "${SOCI_RUNNER}" != "docker" ]]; then
    echo "Unsupported SOCI_RUNNER=${SOCI_RUNNER}. Use docker or local." >&2
    exit 1
  fi

  docker build \
    --platform "${SOCI_DOCKER_PLATFORM}" \
    --build-arg "SOCI_VERSION=${SOCI_VERSION}" \
    -t "${SOCI_IMAGE}" \
    tools/soci
}

run_soci_convert() {
  local platform="$1"
  local source_archive="$2"
  local soci_archive="$3"

  if [[ "${SOCI_RUNNER}" == "local" ]]; then
    soci convert --standalone --platform "${platform}" "${source_archive}" "${soci_archive}"
    return
  fi

  local docker_args=(run --rm --platform "${SOCI_DOCKER_PLATFORM}" -v "${PWD}:/work" -w /work)
  if [[ "${SOCI_DOCKER_PRIVILEGED}" == "1" ]]; then
    docker_args+=(--privileged)
  fi
  docker_args+=("${SOCI_IMAGE}" convert --standalone --platform "${platform}" "${source_archive}" "${soci_archive}")
  docker "${docker_args[@]}"
}

verify_soci_push() {
  local tag="$1"
  local tag_manifest_type
  local soci_artifact_count

  tag_manifest_type="$(aws ecr describe-images \
    --region "${REGION}" \
    --repository-name "${REPOSITORY_URI##*/}" \
    --image-ids "imageTag=${tag}" \
    --query "imageDetails[0].imageManifestMediaType" \
    --output text)"
  soci_artifact_count="$(aws ecr describe-images \
    --region "${REGION}" \
    --repository-name "${REPOSITORY_URI##*/}" \
    --query "length(imageDetails[?artifactMediaType=='application/vnd.amazon.soci.index.v2+json'])" \
    --output text)"

  echo "Pushed ${tag}: manifestType=${tag_manifest_type}, repositorySociArtifacts=${soci_artifact_count}"
}

prepare_crane_layout() {
  local archive="$1"
  local layout_dir="$2"
  local nested_digest

  rm -rf "${layout_dir}"
  mkdir -p "${layout_dir}"
  tar -xf "${archive}" -C "${layout_dir}"

  # soci convert writes an OCI archive whose top-level index points at another
  # OCI index. Push the nested index as the tag target so ECR sees the image
  # manifest and SOCI artifact as direct index entries.
  nested_digest="$(jq -r '
    if (.manifests | length) == 1 and .manifests[0].mediaType == "application/vnd.oci.image.index.v1+json"
    then .manifests[0].digest
    else empty
    end
  ' "${layout_dir}/index.json")"

  if [[ -n "${nested_digest}" ]]; then
    cp "${layout_dir}/blobs/sha256/${nested_digest#sha256:}" "${layout_dir}/index.json"
  fi
}

push_oci_archive_with_crane() {
  local archive="$1"
  local tag="$2"
  local layout_dir="${WORK_DIR}/push-${tag}"

  prepare_crane_layout "${archive}" "${layout_dir}"
  crane push --index "${layout_dir}" "${REPOSITORY_URI}:${tag}"
}

build_one() {
  local cpu_architecture="$1"
  local platform="$2"
  local size="$3"
  local compression="$4"
  local soci_mode="$5"
  local requirements_file="$6"
  local dependency_profile="$7"
  local tag="${cpu_architecture}-${size}-${compression}-${soci_mode}"
  local source_archive="${WORK_DIR}/${tag}.oci.tar"
  local soci_archive="${WORK_DIR}/${tag}.soci.oci.tar"
  local compression_option="${compression}"

  if [[ "${compression}" == "uncompressed" ]]; then
    compression_option="uncompressed"
  fi

  echo "Building ${REPOSITORY_URI}:${tag} (${platform}, ${requirements_file}, ${compression}, ${soci_mode})"
  docker buildx build \
    --builder "${BUILDX_BUILDER}" \
    --platform "${platform}" \
    --build-arg "REQUIREMENTS_FILE=${requirements_file}" \
    --build-arg "DEPENDENCY_PROFILE=${dependency_profile}" \
    --build-arg "VARIANT_TAG=${tag}" \
    --provenance=false \
    --sbom=false \
    --output "type=oci,dest=${source_archive},compression=${compression_option},force-compression=true" \
    workload

  if [[ "${soci_mode}" == "soci" ]]; then
    echo "Converting ${tag} to SOCI-enabled OCI image"
    run_soci_convert "${platform}" "${source_archive}" "${soci_archive}"
    push_oci_archive_with_crane "${soci_archive}" "${tag}"
    verify_soci_push "${tag}"
  else
    push_oci_archive_with_crane "${source_archive}" "${tag}"
  fi
}

IFS=',' read -r -a architecture_list <<< "${ARCHITECTURES}"

ensure_buildx_builder
ensure_soci_runner

for cpu_architecture in "${architecture_list[@]}"; do
  case "${cpu_architecture}" in
    x86_64) platform="linux/amd64" ;;
    arm64) platform="linux/arm64" ;;
    *) echo "Unsupported architecture: ${cpu_architecture}. Use x86_64 or arm64." >&2; exit 1 ;;
  esac

  for size in small large; do
    if [[ "${size}" == "small" ]]; then
      requirements_file="${SMALL_REQUIREMENTS_FILE}"
      dependency_profile="small"
    else
      requirements_file="${LARGE_REQUIREMENTS_FILE}"
      dependency_profile="large"
    fi

    for image_format in gzip:plain gzip:soci zstd:plain uncompressed:plain uncompressed:soci; do
      compression="${image_format%%:*}"
      soci_mode="${image_format##*:}"
      build_one "${cpu_architecture}" "${platform}" "${size}" "${compression}" "${soci_mode}" "${requirements_file}" "${dependency_profile}"
    done
  done
done

echo "Pushed all benchmark images to ${REPOSITORY_URI}"
