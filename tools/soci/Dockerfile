# syntax=docker/dockerfile:1.7
FROM public.ecr.aws/docker/library/debian:bookworm-slim

ARG SOCI_VERSION=0.14.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH}" in \
    amd64) soci_arch="amd64" ;; \
    arm64) soci_arch="arm64" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL \
    "https://github.com/awslabs/soci-snapshotter/releases/download/v${SOCI_VERSION}/soci-snapshotter-${SOCI_VERSION}-linux-${soci_arch}.tar.gz" \
    -o /tmp/soci-snapshotter.tar.gz \
  && tar -C /usr/local/bin -xzf /tmp/soci-snapshotter.tar.gz soci \
  && chmod +x /usr/local/bin/soci \
  && rm -f /tmp/soci-snapshotter.tar.gz \
  && soci --help >/dev/null

ENTRYPOINT ["soci"]
