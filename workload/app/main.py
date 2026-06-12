import hashlib
import importlib
import json
import os
import time
from pathlib import Path


def read_int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def import_generated_modules(module_count: int) -> int:
    score = 0
    for index in range(module_count):
        module = importlib.import_module(f"generated_deps.module_{index:04d}")
        score ^= module.score(index)
    return score


def hash_payload(path: Path, read_mb: int) -> tuple[str, int]:
    hasher = hashlib.sha256()
    remaining = read_mb * 1024 * 1024
    bytes_read = 0
    with path.open("rb") as payload:
        while remaining > 0:
            chunk = payload.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            hasher.update(chunk)
            bytes_read += len(chunk)
            remaining -= len(chunk)
    return hasher.hexdigest(), bytes_read


def main() -> None:
    start = time.perf_counter()
    module_count = read_int_env("MODULE_COUNT", 384)
    read_mb = read_int_env("READ_MB", 192)

    import_start = time.perf_counter()
    module_score = import_generated_modules(module_count)
    import_done = time.perf_counter()

    digest, bytes_read = hash_payload(Path("/opt/benchmark/payload/blob.dat"), read_mb)
    done = time.perf_counter()

    print(json.dumps({
        "event": "benchmark-complete",
        "image_tag": os.environ.get("BENCHMARK_IMAGE_TAG"),
        "cpu_architecture": os.environ.get("BENCHMARK_CPU_ARCHITECTURE"),
        "image_size": os.environ.get("BENCHMARK_IMAGE_SIZE"),
        "compression": os.environ.get("BENCHMARK_COMPRESSION"),
        "soci_mode": os.environ.get("BENCHMARK_SOCI_MODE"),
        "variant_tag": os.environ.get("BENCHMARK_VARIANT_TAG"),
        "run_id": os.environ.get("BENCHMARK_RUN_ID"),
        "module_count": module_count,
        "module_score": module_score,
        "payload_bytes_read": bytes_read,
        "payload_sha256": digest,
        "import_ms": round((import_done - import_start) * 1000, 3),
        "payload_read_ms": round((done - import_done) * 1000, 3),
        "total_process_ms": round((done - start) * 1000, 3),
    }), flush=True)


if __name__ == "__main__":
    main()
