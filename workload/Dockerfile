# syntax=docker/dockerfile:1.7
FROM public.ecr.aws/docker/library/python:3.12-slim

ARG TARGET_MB=192
ARG READ_MB=${TARGET_MB}
ARG MODULE_COUNT=384
ARG VARIANT_TAG=local

ENV READ_MB=${READ_MB}
ENV TARGET_MB=${TARGET_MB}
ENV MODULE_COUNT=${MODULE_COUNT}
ENV VARIANT_TAG=${VARIANT_TAG}
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV BENCHMARK_VARIANT_TAG=${VARIANT_TAG}

WORKDIR /opt/benchmark
COPY app/ ./app/

RUN python - <<'PY'
import hashlib
import os
import random
from pathlib import Path

target_mb = int(os.environ.get("TARGET_MB", "192"))
module_count = int(os.environ.get("MODULE_COUNT", "384"))
variant_tag = os.environ.get("VARIANT_TAG", "local")

root = Path("/opt/benchmark")
pkg = root / "generated_deps"
payload = root / "payload"
pkg.mkdir(parents=True, exist_ok=True)
payload.mkdir(parents=True, exist_ok=True)

(pkg / "__init__.py").write_text(
    "MODULE_COUNT = %d\n"
    "def expected():\n"
    "    return MODULE_COUNT\n" % module_count
)

for index in range(module_count):
    digest = hashlib.sha256(f"{variant_tag}:{index}".encode()).hexdigest()
    constants = [int(digest[offset:offset + 8], 16) for offset in range(0, 64, 8)]
    body = [
        f"VALUES = {constants!r}",
        "def score(seed: int) -> int:",
        "    value = seed",
    ]
    for value in constants:
        body.append(f"    value = ((value * 1103515245) + {value}) & 0xffffffff")
    body.append("    return value")
    (pkg / f"module_{index:04d}.py").write_text("\n".join(body) + "\n")

chunk_size = 1024 * 1024
random_bytes = int(chunk_size * 0.65)
pattern_bytes = chunk_size - random_bytes
rng = random.Random(hashlib.sha256(variant_tag.encode()).digest())
patterns = [
    (hashlib.sha256(f"{variant_tag}:pattern:{i}".encode()).digest() * ((pattern_bytes // 32) + 1))[:pattern_bytes]
    for i in range(8)
]

with (payload / "blob.dat").open("wb") as output:
    for mb in range(target_mb):
        output.write(rng.randbytes(random_bytes))
        output.write(patterns[mb % len(patterns)])
PY

CMD ["python", "-m", "app.main"]
