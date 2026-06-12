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

The workload image generates a synthetic Python package and a large payload inside the
image. At runtime it imports the generated modules and streams the payload so startup
requires real reads from the image filesystem.

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
  -c ec2RootVolumeGiB=100
```

The subnet IDs are a CSV value. They must belong to the supplied VPC and must provide
outbound access to ECR and CloudWatch Logs, either through public internet routing or
private endpoints/NAT.

## Build and push images

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run build-images
```

Defaults:

- `SMALL_MB=192`, which lands near a 256 MiB image once the runtime and generated
  modules are included.
- `LARGE_MB=1920`, which lands near a 2 GiB image.
- `MODULE_COUNT=384`.
- `ARCHITECTURES=x86_64,arm64`.
- `BUILDX_BUILDER=container-start-speed`.
- `SOCI_RUNNER=docker`.
- `SOCI_VERSION=0.14.0`.
- `SOCI_DOCKER_PRIVILEGED=1`.

Override them when needed:

```bash
SMALL_MB=224 LARGE_MB=2048 MODULE_COUNT=512 ARCHITECTURES=x86_64 AWS_REGION=eu-west-1 npm run build-images
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

## Run benchmark

The default run executes 30 tasks per selected permutation. With all defaults that is
`3 targets * 2 architectures * 2 sizes * 5 valid compression/SOCI formats * 30 = 1800` tasks.

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run benchmark
```

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
- `--out results`
- `--poll-seconds 10`
- `--timeout-minutes 60`

## Results

Each run writes to `results/<run-id>/`:

- `tasks.jsonl`: raw per-task records.
- `tasks.csv`: flattened per-task records.
- `summary.csv`: grouped metrics with `n`, mean, 95% CI, min, p50, p90, p95, max.
- `summary.json`: JSON version of the summary.
- `run.json`: run metadata and stack outputs.

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

## Notes

- EC2 Auto Scaling groups have minimum capacity `0`; the first EC2 run includes
  capacity scale-out effects. Re-run against the same deployed stack to measure warm
  EC2 task starts with instance and image-cache effects.
- Fargate task definitions use 50 GiB ephemeral storage to avoid large-image staging
  constraints.
- EC2 task definitions use bridge networking to avoid allocating one ENI per task.
- SOCI is represented by separate image tags with distinct image digests so plain
  controls do not share a SOCI-enabled subject digest.
