#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-ContainerStartSpeedStack}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
SMALL_MB="${SMALL_MB:-192}"
LARGE_MB="${LARGE_MB:-1920}"
MODULE_COUNT="${MODULE_COUNT:-384}"
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
command -v skopeo >/dev/null || { echo "skopeo is required for OCI archive push/copy." >&2; exit 1; }

REGISTRY="${REPOSITORY_URI%/*}"
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"
aws ecr get-login-password --region "${REGION}" | skopeo login --username AWS --password-stdin "${REGISTRY}"

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

build_one() {
  local cpu_architecture="$1"
  local platform="$2"
  local skopeo_arch="$3"
  local size="$4"
  local compression="$5"
  local soci_mode="$6"
  local target_mb="$7"
  local tag="${cpu_architecture}-${size}-${compression}-${soci_mode}"
  local source_archive="${WORK_DIR}/${tag}.oci.tar"
  local soci_archive="${WORK_DIR}/${tag}.soci.oci.tar"
  local compression_option="${compression}"

  if [[ "${compression}" == "uncompressed" ]]; then
    compression_option="uncompressed"
  fi

  echo "Building ${REPOSITORY_URI}:${tag} (${platform}, ${target_mb} MiB payload, ${compression}, ${soci_mode})"
  docker buildx build \
    --builder "${BUILDX_BUILDER}" \
    --platform "${platform}" \
    --build-arg "TARGET_MB=${target_mb}" \
    --build-arg "READ_MB=${target_mb}" \
    --build-arg "MODULE_COUNT=${MODULE_COUNT}" \
    --build-arg "VARIANT_TAG=${tag}" \
    --provenance=false \
    --sbom=false \
    --output "type=oci,dest=${source_archive},compression=${compression_option},force-compression=true" \
    workload

  if [[ "${soci_mode}" == "soci" ]]; then
    echo "Converting ${tag} to SOCI-enabled OCI image"
    run_soci_convert "${platform}" "${source_archive}" "${soci_archive}"
    skopeo copy --override-os linux --override-arch "${skopeo_arch}" "oci-archive:${soci_archive}" "docker://${REPOSITORY_URI}:${tag}"
  else
    skopeo copy --override-os linux --override-arch "${skopeo_arch}" "oci-archive:${source_archive}" "docker://${REPOSITORY_URI}:${tag}"
  fi
}

IFS=',' read -r -a architecture_list <<< "${ARCHITECTURES}"

ensure_buildx_builder
ensure_soci_runner

for cpu_architecture in "${architecture_list[@]}"; do
  case "${cpu_architecture}" in
    x86_64) platform="linux/amd64"; skopeo_arch="amd64" ;;
    arm64) platform="linux/arm64"; skopeo_arch="arm64" ;;
    *) echo "Unsupported architecture: ${cpu_architecture}. Use x86_64 or arm64." >&2; exit 1 ;;
  esac

  for size in small large; do
    if [[ "${size}" == "small" ]]; then
      target_mb="${SMALL_MB}"
    else
      target_mb="${LARGE_MB}"
    fi

    for image_format in gzip:plain gzip:soci zstd:plain uncompressed:plain uncompressed:soci; do
      compression="${image_format%%:*}"
      soci_mode="${image_format##*:}"
      build_one "${cpu_architecture}" "${platform}" "${skopeo_arch}" "${size}" "${compression}" "${soci_mode}" "${target_mb}"
    done
  done
done

echo "Pushed all benchmark images to ${REPOSITORY_URI}"
