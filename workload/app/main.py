import json
import os
import time
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


def load_ecs_metadata() -> dict[str, Any]:
    metadata_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not metadata_uri:
        return {"available": False, "error": "ECS_CONTAINER_METADATA_URI_V4 is not set"}

    try:
        with urlopen(f"{metadata_uri}/task", timeout=2) as response:
            task_metadata = json.load(response)
    except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
        return {"available": False, "error": str(error)}

    container_name = os.environ.get("ECS_CONTAINER_METADATA_CONTAINER_NAME", "workload")
    containers = task_metadata.get("Containers") or []
    current_container = next(
        (container for container in containers if container.get("Name") == container_name),
        containers[0] if containers else {},
    )

    return {
        "available": True,
        "task_arn": task_metadata.get("TaskARN"),
        "launch_type": task_metadata.get("LaunchType"),
        "availability_zone": task_metadata.get("AvailabilityZone"),
        "container_name": current_container.get("Name"),
        "image": current_container.get("Image"),
        "image_id": current_container.get("ImageID"),
        "snapshotter": current_container.get("Snapshotter"),
    }


def exercise_common_dependencies() -> dict[str, Any]:
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(20260616)
    matrix = rng.normal(size=(512, 32)).astype(np.float32)
    frame = pd.DataFrame(matrix[:, :8], columns=[f"feature_{index}" for index in range(8)])

    return {
        "numpy_shape": list(matrix.shape),
        "numpy_mean": round(float(matrix.mean()), 6),
        "pandas_columns": len(frame.columns),
        "pandas_checksum": round(float(frame.sum().sum()), 6),
        "numpy_version": np.__version__,
        "pandas_version": pd.__version__,
    }


def exercise_large_dependencies() -> dict[str, Any]:
    import cv2
    import numpy as np
    import pyarrow as pa
    import scipy.sparse as sp
    import torch
    import xgboost as xgb
    import safetensors.torch
    import transformers
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from transformers import BertConfig, BertModel

    rng = np.random.default_rng(20260616)
    matrix = rng.normal(size=(256, 64)).astype(np.float32)
    arrow_table = pa.table({
        "feature_0": matrix[:, 0],
        "feature_1": matrix[:, 1],
        "feature_2": matrix[:, 2],
    })

    sparse_matrix = sp.csr_matrix(matrix)
    svd = TruncatedSVD(n_components=8, random_state=42)
    components = svd.fit_transform(sparse_matrix)

    documents = [
        "container image lazy loading pulls files on demand",
        "scientific python dependencies include compiled native extensions",
        "compression ratios depend on repeated structured data",
        "ecs task startup timing includes image pull and container creation",
    ]
    tfidf = TfidfVectorizer(ngram_range=(1, 2)).fit_transform(documents)

    tensor = torch.from_numpy(matrix)
    gram = torch.mm(tensor[:64], tensor[:64].T)
    model = BertModel(BertConfig(hidden_size=32, intermediate_size=64, num_attention_heads=4, num_hidden_layers=1))
    safetensors.torch.save({"gram": gram}, metadata={"format": "pt"})

    labels = (matrix[:, 0] > 0).astype(np.int32)
    dmatrix = xgb.DMatrix(matrix[:, :8], label=labels)
    booster = xgb.train({"objective": "binary:logistic", "max_depth": 2, "verbosity": 0}, dmatrix, num_boost_round=1)

    image = np.zeros((64, 64, 3), dtype=np.uint8)
    image[:, :, 1] = 128
    edges = cv2.Canny(image, 50, 100)

    return {
        "pyarrow_rows": arrow_table.num_rows,
        "scipy_nonzero": int(sparse_matrix.nnz),
        "sklearn_svd_sum": round(float(np.sum(components)), 6),
        "sklearn_tfidf_terms": int(tfidf.shape[1]),
        "torch_trace": round(float(torch.trace(gram).item()), 6),
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
        "bert_parameters": sum(parameter.numel() for parameter in model.parameters()),
        "xgboost_trees": int(len(booster.get_dump())),
        "opencv_edge_sum": int(edges.sum()),
        "opencv_version": cv2.__version__,
    }


def main() -> None:
    start = time.perf_counter()
    dependency_profile = os.environ.get("DEPENDENCY_PROFILE", "small")

    common_start = time.perf_counter()
    common_result = exercise_common_dependencies()
    common_done = time.perf_counter()

    large_result = None
    large_start = common_done
    large_done = common_done
    if dependency_profile == "large":
        large_start = time.perf_counter()
        large_result = exercise_large_dependencies()
        large_done = time.perf_counter()

    ecs_metadata = load_ecs_metadata()

    print(json.dumps({
        "event": "benchmark-complete",
        "image_tag": os.environ.get("BENCHMARK_IMAGE_TAG"),
        "cpu_architecture": os.environ.get("BENCHMARK_CPU_ARCHITECTURE"),
        "image_size": os.environ.get("BENCHMARK_IMAGE_SIZE"),
        "compression": os.environ.get("BENCHMARK_COMPRESSION"),
        "soci_mode": os.environ.get("BENCHMARK_SOCI_MODE"),
        "variant_tag": os.environ.get("BENCHMARK_VARIANT_TAG"),
        "run_id": os.environ.get("BENCHMARK_RUN_ID"),
        "dependency_profile": dependency_profile,
        "ecs_metadata": ecs_metadata,
        "snapshotter": ecs_metadata.get("snapshotter"),
        "common_dependency_result": common_result,
        "large_dependency_result": large_result,
        "common_dependency_ms": round((common_done - common_start) * 1000, 3),
        "large_dependency_ms": round((large_done - large_start) * 1000, 3),
        "total_process_ms": round((large_done - start) * 1000, 3),
    }), flush=True)


if __name__ == "__main__":
    main()
