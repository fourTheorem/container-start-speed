# How fast can an ECS container start?

A bigger container image means a slower start. But how much slower? And what makes
more difference: compression, CPU architecture, the host OS, or lazy loading?

This repo is the experiment behind our _AWS Bites_ episode on container startup.
We ran **1,320 ECS tasks** across Fargate and EC2 to see where the time goes.
The biggest difference came from SOCI. A large image that took almost two minutes
to start on Fargate with gzip took about 18 seconds with SOCI enabled.

**Coming from the podcast?** Start with the findings below. You can find AWS Bites
in audio and video at [awsbites.com](https://awsbites.com).

- [What we found](#what-we-found)
- [What we measured](#what-we-measured)
- [Run it yourself](#run-it-yourself)
- [Explore the results](#explore-the-results)

## What we found

These are results from one run in **eu-west-1**, with **30 tasks per configuration**.
Times below are medians, measured from **ECS task created to container started**.
That is different from the time it takes the application to finish importing its
dependencies or become ready to serve traffic.

### SOCI made the biggest difference on Fargate

SOCI (Seekable OCI) lets a container start without downloading the whole image
first. For the large images in this run, that changed startup from minutes to
seconds.

| Large image on Fargate (x86_64) | Without SOCI | With SOCI |
| --- | --- | --- |
| Uncompressed | 161s | 16s (~10× faster) |
| gzip | 117s | 17.5s (~6.7× faster) |

With SOCI, both small and large images started in roughly **14–18 seconds**.
The image pull phase fell to 2–5 seconds; about 13 seconds remained between task
creation and the start of the pull.

The improvement was smaller for small images:

| Small image on Fargate | Without SOCI (x86_64) | With SOCI (x86_64) | With SOCI (arm64) |
| --- | --- | --- | --- |
| Uncompressed | 19.7s | 16.4s | 13.8s |
| gzip | 19.7s | 15.4s | 14.8s |

There is no zstd + SOCI comparison in this benchmark: SOCI does not support
zstd-compressed layers.

### Compression helped large images; zstd was a modest extra win

For large x86_64 images on Fargate without SOCI, startup took **161s uncompressed,
117s with gzip, and 113s with zstd**. The image pull phase fell from about 145s
uncompressed to about 95s with zstd.

In this run, transferring fewer bytes more than made up for decompression time.
zstd shaved another 3–5% off large-image startup compared with gzip. For small
images, compression made no consistent difference: x86_64 starts were around
19–20 seconds across all three formats.

### Warm EC2 hosts were quick, but the comparison needs care

On a warm EC2 host, small images without gzip started in about **5 seconds**,
compared with roughly **19 seconds** on Fargate. For large gzip/zstd images,
EC2 medians were around **80 seconds**, against roughly **115 seconds** on Fargate.
Fargate with SOCI brought large-image starts down to about **16 seconds**.

The EC2 Auto Scaling groups started with zero instances. The first configuration
on each host therefore included instance provisioning, mixing cold and warm
starts in the results. Medians are more useful than means here, but they do not
remove every host or image-cache effect. Treat the small gzip EC2 results as
cold-start artifacts; a controlled warm-host run would make a better comparison.

SOCI lazy loading is only used on Fargate in this benchmark. EC2 SOCI variants can
be included as controls, but the ECS agent does not use them for lazy loading.

### Architecture and host OS made smaller differences

- **Amazon Linux 2023 vs Bottlerocket:** there was no consistent difference in the
  warm-host results. Small-image medians were about 5–6s on both; large gzip/zstd
  medians were about 80–84s. Cold-instance effects skewed the means, so this run
  does not establish a winner.
- **x86_64 vs arm64 on Fargate:** arm64 was faster in several small-image cases.
  Small gzip went from 19.7s to 16.4s; small gzip + SOCI from 15.4s to 14.8s;
  small uncompressed + SOCI from 16.4s to 13.8s. There was no meaningful difference
  for small uncompressed images without SOCI or large uncompressed images with SOCI.

## What we measured

The benchmark varies six things:

| Variable | Options |
| --- | --- |
| Where the task runs | Fargate or ECS on EC2 |
| CPU architecture | x86_64 or arm64 |
| Image size | Small scientific Python stack or large ML/data stack |
| Image compression | gzip, zstd, or uncompressed |
| Lazy loading | Plain image or SOCI, where supported |
| EC2 host OS | Amazon Linux 2023 or Bottlerocket |

The images contain real Python dependencies, and the workload imports and
exercises them. They are not padded with filler files.

| Image | Uncompressed | gzip | zstd |
| --- | --- | --- | --- |
| Small | ~250 MB | ~74 MB | ~67 MB |
| Large | ~6 GB | ~3 GB | ~200 MB less than gzip |

The headline metric is `createdToStartedMs`. The runner also records the image
pull phase, total task duration, and workload dependency timings, so you can
look beyond container startup in the output.

## Run it yourself

The steps below deploy the benchmark infrastructure, build and verify the
images, and run the tasks in your AWS account. The default full run launches
**1,320 tasks**; a smaller Fargate run is shown first in the benchmark step.

### What gets deployed

- One ECR repository for benchmark images.
- One Fargate ECS cluster.
- Two ECS-on-EC2 clusters backed by Amazon Linux 2023 ECS-optimised AMIs:
  one `x86_64`, one `arm64`.
- Two ECS-on-EC2 clusters backed by Bottlerocket ECS AMIs:
  one `x86_64`, one `arm64`.
- Task definitions for the image and launch combinations described above.

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

### Before you start

- AWS CLI authenticated to the target account.
- Docker with Buildx.
- `crane` for pushing OCI images to ECR without recompressing layers.
- `jq` for inspecting generated OCI layouts.
- CDK bootstrap already completed in the target account/region.

The image builder runs `soci convert --standalone` inside a privileged Linux Docker
container by default. This also works from macOS: SOCI reads and writes OCI archives
mounted from the workspace. Set `SOCI_RUNNER=local` only on Linux with the `soci` CLI
already installed.

### 1. Deploy the infrastructure

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

### 2. Build, push, and verify the images

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run build-images
```

Verify the pushed ECR tags before running benchmarks:

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run verify-images
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
All image variants are pushed with `crane push --index` from generated OCI
layouts. This preserves gzip, zstd, and uncompressed layer media types and keeps
SOCI artifact entries attached to SOCI image indexes.
You can also inspect the repository directly:

```bash
aws ecr describe-images \
  --repository-name css-bench-images \
  --query "imageDetails[].{tags:imageTags,manifest:imageManifestMediaType,artifact:artifactMediaType}"
```

SOCI-enabled tags should have `application/vnd.oci.image.index.v1+json`, and the
repository should include untagged artifacts with
`application/vnd.amazon.soci.index.v2+json`.

`npm run verify-images` checks each expected benchmark tag in ECR, follows OCI
indexes to the platform image manifest, verifies every layer media type matches
the tag's `gzip`, `zstd`, or `uncompressed` label, and verifies SOCI tags contain
a SOCI artifact reference. Use `--architectures`, `--sizes`, and `--formats` for
targeted checks while iterating:

```bash
AWS_REGION="${CDK_DEFAULT_REGION}" npm run verify-images -- \
  --architectures x86_64 \
  --sizes small \
  --formats uncompressed:plain,uncompressed:soci
```

### 3. Run the benchmark

Start with a small run to try it out:

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

The default run executes 30 tasks per selected permutation. With all defaults that is
`44 permutations * 30 = 1320` tasks:

- Fargate: `2 architectures * 2 sizes * 5 valid compression/SOCI formats = 20`
- ECS on EC2: `2 host OS targets * 2 architectures * 2 sizes * 3 plain compression formats = 24`

SOCI is skipped for ECS on EC2 by default because the ECS agent does not support
SOCI lazy loading on EC2 container instances. Use `--include-ec2-soci` only when
you explicitly want EC2 control data with SOCI artifacts present but not used for
lazy loading.

Run the full comparison:

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

## Explore the results

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

### Timing fields and diagnostics

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

## Implementation notes

- EC2 Auto Scaling groups have minimum capacity `0`; the first EC2 run includes
  capacity scale-out effects. Re-run against the same deployed stack to measure warm
  EC2 task starts with instance and image-cache effects.
- Fargate task definitions use 100 GiB ephemeral storage to avoid large-image staging
  constraints.
- EC2 task definitions use bridge networking to avoid allocating one ENI per task.
- SOCI is represented by separate image tags with distinct image digests so plain
  controls do not share a SOCI-enabled subject digest.
