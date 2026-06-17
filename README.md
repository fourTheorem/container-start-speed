# ECS container start speed benchmark

This CDK app builds a benchmark for measuring ECS task start latency across CPU
architecture, image size, launch target, EC2 host OS, image compression, and SOCI.

## What it deploys

- One ECR repository for benchmark images.
- One Fargate ECS cluster.
- Two ECS-on-EC2 clusters backed by Amazon Linux 2023 ECS-optimized AMIs:
  one `x86_64`, one `arm64`.
- Two ECS-on-EC2 clusters backed by Bottlerocket ECS AMIs:
  one `x86_64`, one `arm64`.
- Task definitions for every image permutation:
  - CPU architecture: `x86_64`, `arm64`
  - image size: `small`, `large`
  - compression: `gzip`, `zstd`, `uncompressed`
  - SOCI mode: `plain`, `soci`
  - launch family: `fargate`, `ec2`

SOCI variants are built only for `gzip` and `uncompressed` images. `zstd+soci` is
intentionally excluded because SOCI does not support zstd-compressed layers.

The stack imports an existing VPC from CDK context. It does not create a VPC or
subnets.

The workload image uses two dependency profiles:

- `small`: installs `workload/requirements-small.txt` for a smaller scientific
  Python stack.
- `large`: installs `workload/requirements-large.txt` for a heavier ML/data
  stack including PyTorch, scikit-learn, PyArrow, XGBoost, OpenCV, and
  Transformers.

At runtime the workload imports and exercises the installed dependency profile,
so the image contents are real dependency files rather than generated filler
files.

## Prerequisites

- AWS CLI authenticated to the target account.
- Docker with Buildx.
- `skopeo` for copying OCI archives to ECR.
- CDK bootstrap already completed in the target account/region.

The image builder runs `soci convert --standalone` inside a privileged Linux Docker
container by default. This works from macOS hosts because SOCI processes OCI archives
mounted from the workspace and writes the converted archive back to disk. Set
`SOCI_RUNNER=local` only if you are on Linux and already have the `soci` CLI installed.

## Deploy

```bash
npm install
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION="${AWS_REGION:-eu-west-1}"
npm run cdk -- deploy \
  -c vpcId=vpc-0123456789abcdef0 \
  -c subnetIds=subnet-aaaaaaaaaaaaaaaaa,subnet-bbbbbbbbbbbbbbbbb
```

Useful CDK context settings:

```bash
npm run cdk -- deploy \
  -c vpcId=vpc-0123456789abcdef0 \
  -c subnetIds=subnet-aaaaaaaaaaaaaaaaa,subnet-bbbbbbbbbbbbbbbbb \
  -c benchmarkName=css-bench \
  -c ec2X86InstanceType=m7i.large \
  -c ec2ArmInstanceType=m7g.large \
  -c maxEc2Instances=8 \
  -c ec2RootVolumeGiB=300 \
  -c fargateEphemeralStorageGiB=100
```

The larger EC2 root volume is intentional: the large dependency profile includes
ML packages such as PyTorch and Triton, and uncompressed image variants need
substantial host image-storage space while ECS pulls and registers layers.

The subnet IDs are a CSV value. They must belong to the supplied VPC and must provide
outbound access to ECR and CloudWatch Logs, either through public internet routing or
private endpoints/NAT.

## Build and push images

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run build-images
```

Defaults:

- `SMALL_REQUIREMENTS_FILE=requirements-small.txt`.
- `LARGE_REQUIREMENTS_FILE=requirements-large.txt`.
- `ARCHITECTURES=x86_64,arm64`.
- `BUILDX_BUILDER=container-start-speed`.
- `SOCI_RUNNER=docker`.
- `SOCI_VERSION=0.14.0`.
- `SOCI_DOCKER_PRIVILEGED=1`.

Override them when needed:

```bash
SMALL_REQUIREMENTS_FILE=requirements-small.txt LARGE_REQUIREMENTS_FILE=requirements-large.txt ARCHITECTURES=x86_64 AWS_REGION=eu-west-1 npm run build-images
```

Use local SOCI instead of Docker on Linux:

```bash
SOCI_RUNNER=local AWS_REGION=eu-west-1 npm run build-images
```

Disable privileged Docker mode if your Docker environment does not require it:

```bash
SOCI_DOCKER_PRIVILEGED=0 AWS_REGION=eu-west-1 npm run build-images
```

On Docker Desktop, the default Buildx `docker` driver cannot export OCI archives.
The script automatically creates and uses a `docker-container` builder named
`container-start-speed`. Override it with `BUILDX_BUILDER=...` if needed.

For SOCI variants, the script pushes the complete SOCI index manifest v2 image
index to ECR. After a successful SOCI push, the script prints the pushed tag's
manifest type and the number of SOCI v2 artifacts visible in the repository.
You can also inspect the repository directly:

```bash
aws ecr describe-images \
  --repository-name css-bench-images \
  --query "imageDetails[].{tags:imageTags,manifest:imageManifestMediaType,artifact:artifactMediaType}"
```

SOCI-enabled tags should have `application/vnd.oci.image.index.v1+json`, and the
repository should include untagged artifacts with
`application/vnd.amazon.soci.index.v2+json`.

## Run benchmark

The default run executes 30 tasks per selected permutation. With all defaults that is
`44 permutations * 30 = 1320` tasks:

- Fargate: `2 architectures * 2 sizes * 5 valid compression/SOCI formats = 20`
- ECS on EC2: `2 host OS targets * 2 architectures * 2 sizes * 3 plain compression formats = 24`

SOCI is skipped for ECS on EC2 by default because the ECS agent does not support
SOCI lazy loading on EC2 container instances. Use `--include-ec2-soci` only when
you explicitly want EC2 control data with SOCI artifacts present but not used for
lazy loading.

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run benchmark
```

Show runner help:

```bash
npm run benchmark -- --help
```

Resume the most recent interrupted run:

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run benchmark -- --resume latest
```

Or resume a specific run directory:

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run benchmark -- --resume results/ecs-start-2026-06-12T17-04-00-839Z
```

Resume reads `tasks.jsonl`, skips permutations that already have at least
`--task-count` successful records, and starts again from the first incomplete
permutation. Failed ECS tasks are preserved in `tasks.jsonl` for diagnostics but
do not count as completed benchmark samples. Use the same filter options
(`--targets`, `--architectures`, `--sizes`, `--compressions`, `--soci`) as the
original run when resuming a narrowed run.

Narrow a run while iterating:

```bash
npm run benchmark -- \
  --task-count 5 \
  --batch-size 5 \
  --targets fargate \
  --architectures arm64 \
  --sizes small \
  --compressions gzip \
  --soci plain,soci
```

CLI options:

- `--stack ContainerStartSpeedStack`
- `--region eu-west-1`
- `--task-count 30`
- `--batch-size 10`
- `--targets fargate,ec2-amazon-linux,ec2-bottlerocket`
- `--architectures x86_64,arm64`
- `--sizes small,large`
- `--compressions gzip,zstd,uncompressed`
- `--soci plain,soci`
- `--include-ec2-soci`
- `--out results`
- `--resume latest` or `--resume results/<run-id>`
- `--poll-seconds 10`
- `--timeout-minutes 60`
- `--leave-timed-out-tasks`

If a launched batch does not fully stop before `--timeout-minutes`, the runner
records the latest ECS state for every task in the batch, marks unfinished tasks
with `benchmarkError`, stops those benchmark tasks by default, and continues to
the next permutation. `--resume` will later replace only the missing successful
samples. Use `--leave-timed-out-tasks` when you want to inspect stuck tasks in ECS.

## Results

Each run writes to `results/<run-id>/`:

- `tasks.jsonl`: raw per-task records.
- `tasks.csv`: flattened per-task records.
- `summary.csv`: grouped metrics with `n`, mean, 95% CI, min, p50, p90, p95, max.
- `summary.json`: JSON version of the summary.
- `run.json`: run metadata and stack outputs.

Explore results in the separate Plotly Dash viewer:

```bash
cd visualization
uv run --python 3.14 python app.py
```

Open <http://127.0.0.1:8050>. The viewer reads `tasks.jsonl` directly, so it
can show completed runs and interrupted/resumed runs before `summary.csv` exists.
It filters to successful workload starts by default and can include failed or
incomplete tasks when you want to diagnose run failures.

Captured ECS timing fields include:

- `createdAt`
- `pullStartedAt`
- `pullStoppedAt`
- `startedAt`
- `executionStoppedAt`
- `stoppedAt`

Derived metrics include:

- `createdToPullStartMs`
- `imagePullMs`
- `pullStopToStartedMs`
- `createdToStartedMs`
- `createdToStoppedMs`
- `startedToStoppedMs`

For EC2-hosted tasks, the runner also records:

- container instance ARN
- EC2 instance ID
- ECS container-instance `registeredAt`
- EC2 `LaunchTime`
- `ec2LaunchToEcsRegisteredMs`
- `ec2LaunchToTaskCreatedMs`
- `ecsRegisteredToTaskCreatedMs`

The workload logs the ECS task metadata v4 response for its own container. The
runner reads the benchmark-complete log event from CloudWatch Logs and stores:

- `runtimeSnapshotter`: `soci` or `overlayfs` when the Fargate metadata endpoint
  exposes the containerd snapshotter.
- workload dependency timing fields such as `workloadTotalProcessMs`.

## Notes

- EC2 Auto Scaling groups have minimum capacity `0`; the first EC2 run includes
  capacity scale-out effects. Re-run against the same deployed stack to measure warm
  EC2 task starts with instance and image-cache effects.
- Fargate task definitions use 100 GiB ephemeral storage to avoid large-image staging
  constraints.
- EC2 task definitions use bridge networking to avoid allocating one ENI per task.
- SOCI is represented by separate image tags with distinct image digests so plain
  controls do not share a SOCI-enabled subject digest.
