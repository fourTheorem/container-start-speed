# syntax=docker/dockerfile:1.7
FROM public.ecr.aws/docker/library/python:3.12-slim

ARG REQUIREMENTS_FILE=requirements-small.txt
ARG DEPENDENCY_PROFILE=small
ARG VARIANT_TAG=local

ENV DEPENDENCY_PROFILE=${DEPENDENCY_PROFILE}
ENV VARIANT_TAG=${VARIANT_TAG}
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV BENCHMARK_VARIANT_TAG=${VARIANT_TAG}

WORKDIR /opt/benchmark
COPY requirements-*.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip \
    && python -m pip install --prefer-binary --no-compile -r "${REQUIREMENTS_FILE}"

COPY app/ ./app/

CMD ["python", "-m", "app.main"]
