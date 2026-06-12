import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

type ImageSize = 'small' | 'large';
type Compression = 'gzip' | 'zstd' | 'uncompressed';
type SociMode = 'plain' | 'soci';
type CpuArch = 'x86_64' | 'arm64';
type TargetName = 'fargate' | 'ec2-amazon-linux' | 'ec2-bottlerocket';

interface Args {
  stackName: string;
  region?: string;
  taskCount: number;
  batchSize: number;
  outDir: string;
  pollSeconds: number;
  timeoutMinutes: number;
  targets: TargetName[];
  architectures: CpuArch[];
  sizes: ImageSize[];
  compressions: Compression[];
  sociModes: SociMode[];
}

interface StackOutputs {
  BenchmarkName: string;
  FargateClusterName: string;
  AmazonLinuxX86ClusterName: string;
  AmazonLinuxX86CapacityProviderName: string;
  AmazonLinuxArmClusterName: string;
  AmazonLinuxArmCapacityProviderName: string;
  BottlerocketX86ClusterName: string;
  BottlerocketX86CapacityProviderName: string;
  BottlerocketArmClusterName: string;
  BottlerocketArmCapacityProviderName: string;
  TaskSecurityGroupId: string;
  SubnetIds?: string;
  PublicSubnetIds?: string;
}

interface ManifestEntry {
  cpuArchitecture: CpuArch;
  imageSize: ImageSize;
  compression: Compression;
  sociMode: SociMode;
  imageTag: string;
  fargateTaskFamily: string;
  ec2TaskFamily: string;
}

interface TargetConfig {
  name: TargetName;
  cpuArchitecture: CpuArch;
  clusterName: string;
  capacityProvider: string;
  taskFamilyKey: 'fargateTaskFamily' | 'ec2TaskFamily';
  requiresNetworkConfiguration: boolean;
}

interface TaskRecord {
  runId: string;
  target: TargetName;
  cpuArchitecture: CpuArch;
  imageSize: ImageSize;
  compression: Compression;
  sociMode: SociMode;
  imageTag: string;
  taskArn: string;
  clusterArn?: string;
  taskDefinitionArn?: string;
  containerInstanceArn?: string;
  ec2InstanceId?: string;
  lastStatus?: string;
  desiredStatus?: string;
  stopCode?: string;
  stoppedReason?: string;
  launchType?: string;
  capacityProviderName?: string;
  availabilityZone?: string;
  connectivityAt?: string;
  createdAt?: string;
  pullStartedAt?: string;
  pullStoppedAt?: string;
  startedAt?: string;
  executionStoppedAt?: string;
  stoppedAt?: string;
  containerName?: string;
  containerImage?: string;
  containerImageDigest?: string;
  containerRuntimeId?: string;
  containerLastStatus?: string;
  containerExitCode?: number;
  containerReason?: string;
  ecsRegisteredAt?: string;
  ec2LaunchTime?: string;
  durationsMs: Record<string, number | null>;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const runId = `ecs-start-${startedAt.replace(/[:.]/g, '-')}`;
const outDir = join(args.outDir, runId);
mkdirSync(outDir, { recursive: true });

const outputs = getStackOutputs(args.stackName, args.region);
const manifest = buildManifest(outputs.BenchmarkName);
const subnets = (outputs.SubnetIds ?? outputs.PublicSubnetIds ?? '').split(',').filter(Boolean);
if (subnets.length === 0) {
  throw new Error('Stack output SubnetIds is empty.');
}
const securityGroups = [outputs.TaskSecurityGroupId];

const targets = buildTargetConfigs(outputs).filter((target) =>
  args.targets.includes(target.name) && args.architectures.includes(target.cpuArchitecture)
);
const selectedManifest = manifest.filter((entry) =>
  args.architectures.includes(entry.cpuArchitecture)
  && args.sizes.includes(entry.imageSize)
  && args.compressions.includes(entry.compression)
  && args.sociModes.includes(entry.sociMode)
);

const records: TaskRecord[] = [];
for (const target of targets) {
  for (const entry of selectedManifest) {
    if (target.cpuArchitecture !== entry.cpuArchitecture) {
      continue;
    }
    console.log(`Running ${target.name} ${entry.cpuArchitecture}/${entry.imageSize}/${entry.compression}/${entry.sociMode}`);
    const taskArns = launchTasks(target, entry, args.taskCount, runId, subnets, securityGroups);
    const tasks = waitForStoppedTasks(target.clusterName, taskArns);
    const ec2Context = target.name === 'fargate' ? new Map<string, Ec2Context>() : loadEc2Context(target.clusterName, tasks);
    for (const task of tasks) {
      records.push(toTaskRecord(runId, target.name, entry, task, ec2Context));
    }
    writeIntermediate(records);
  }
}

const summaryRows = summarize(records);
writeOutputs(records, summaryRows);
console.log(`Wrote ${records.length} task records to ${outDir}`);

function parseArgs(argv: string[]): Args {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, 'true');
    } else {
      options.set(key, next);
      index++;
    }
  }

  return {
    stackName: options.get('stack') ?? 'ContainerStartSpeedStack',
    region: options.get('region'),
    taskCount: Number(options.get('task-count') ?? 30),
    batchSize: Number(options.get('batch-size') ?? 10),
    outDir: options.get('out') ?? 'results',
    pollSeconds: Number(options.get('poll-seconds') ?? 10),
    timeoutMinutes: Number(options.get('timeout-minutes') ?? 60),
    targets: parseList<TargetName>(options.get('targets'), ['fargate', 'ec2-amazon-linux', 'ec2-bottlerocket']),
    architectures: parseList<CpuArch>(options.get('architectures'), ['x86_64', 'arm64']),
    sizes: parseList<ImageSize>(options.get('sizes'), ['small', 'large']),
    compressions: parseList<Compression>(options.get('compressions'), ['gzip', 'zstd', 'uncompressed']),
    sociModes: parseList<SociMode>(options.get('soci'), ['plain', 'soci']),
  };
}

function parseList<T extends string>(value: string | undefined, defaults: T[]): T[] {
  if (!value || value === 'all') {
    return defaults;
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean) as T[];
}

function buildTargetConfigs(outputs: StackOutputs): TargetConfig[] {
  return [
    {
      name: 'fargate',
      cpuArchitecture: 'x86_64',
      clusterName: outputs.FargateClusterName,
      capacityProvider: 'FARGATE',
      taskFamilyKey: 'fargateTaskFamily',
      requiresNetworkConfiguration: true,
    },
    {
      name: 'fargate',
      cpuArchitecture: 'arm64',
      clusterName: outputs.FargateClusterName,
      capacityProvider: 'FARGATE',
      taskFamilyKey: 'fargateTaskFamily',
      requiresNetworkConfiguration: true,
    },
    {
      name: 'ec2-amazon-linux',
      cpuArchitecture: 'x86_64',
      clusterName: outputs.AmazonLinuxX86ClusterName,
      capacityProvider: outputs.AmazonLinuxX86CapacityProviderName,
      taskFamilyKey: 'ec2TaskFamily',
      requiresNetworkConfiguration: false,
    },
    {
      name: 'ec2-amazon-linux',
      cpuArchitecture: 'arm64',
      clusterName: outputs.AmazonLinuxArmClusterName,
      capacityProvider: outputs.AmazonLinuxArmCapacityProviderName,
      taskFamilyKey: 'ec2TaskFamily',
      requiresNetworkConfiguration: false,
    },
    {
      name: 'ec2-bottlerocket',
      cpuArchitecture: 'x86_64',
      clusterName: outputs.BottlerocketX86ClusterName,
      capacityProvider: outputs.BottlerocketX86CapacityProviderName,
      taskFamilyKey: 'ec2TaskFamily',
      requiresNetworkConfiguration: false,
    },
    {
      name: 'ec2-bottlerocket',
      cpuArchitecture: 'arm64',
      clusterName: outputs.BottlerocketArmClusterName,
      capacityProvider: outputs.BottlerocketArmCapacityProviderName,
      taskFamilyKey: 'ec2TaskFamily',
      requiresNetworkConfiguration: false,
    },
  ];
}

function buildManifest(benchmarkName: string): ManifestEntry[] {
  const manifest: ManifestEntry[] = [];
  const architectures: CpuArch[] = ['x86_64', 'arm64'];
  const sizes: ImageSize[] = ['small', 'large'];
  const imageFormats: { compression: Compression; sociMode: SociMode }[] = [
    { compression: 'gzip', sociMode: 'plain' },
    { compression: 'gzip', sociMode: 'soci' },
    { compression: 'zstd', sociMode: 'plain' },
    { compression: 'uncompressed', sociMode: 'plain' },
    { compression: 'uncompressed', sociMode: 'soci' },
  ];

  for (const cpuArchitecture of architectures) {
    for (const imageSize of sizes) {
      for (const imageFormat of imageFormats) {
        const { compression, sociMode } = imageFormat;
        const imageTag = `${cpuArchitecture}-${imageSize}-${compression}-${sociMode}`;
        manifest.push({
          cpuArchitecture,
          imageSize,
          compression,
          sociMode,
          imageTag,
          fargateTaskFamily: `${benchmarkName}-${imageTag}-fargate`,
          ec2TaskFamily: `${benchmarkName}-${imageTag}-ec2`,
        });
      }
    }
  }

  return manifest;
}

function launchTasks(
  target: TargetConfig,
  entry: ManifestEntry,
  taskCount: number,
  runIdValue: string,
  subnets: string[],
  securityGroups: string[],
): string[] {
  const taskArns: string[] = [];
  while (taskArns.length < taskCount) {
    const count = Math.min(args.batchSize, taskCount - taskArns.length);
    const command = [
      'ecs',
      'run-task',
      '--cluster',
      target.clusterName,
      '--task-definition',
      entry[target.taskFamilyKey],
      '--count',
      String(count),
      '--capacity-provider-strategy',
      JSON.stringify([{ capacityProvider: target.capacityProvider, weight: 1 }]),
      '--started-by',
      runIdValue,
      '--overrides',
      JSON.stringify({
        containerOverrides: [
          {
            name: 'workload',
            environment: [
              { name: 'BENCHMARK_RUN_ID', value: runIdValue },
            ],
          },
        ],
      }),
    ];

    if (target.name === 'fargate') {
      command.push('--platform-version', 'LATEST');
    }

    if (target.requiresNetworkConfiguration) {
      command.push(
        '--network-configuration',
        JSON.stringify({
          awsvpcConfiguration: {
            subnets,
            securityGroups,
            assignPublicIp: 'ENABLED',
          },
        }),
      );
    }

    const response = awsJson<RunTaskResponse>(command);
    if (response.failures?.length) {
      throw new Error(`run-task failures: ${JSON.stringify(response.failures)}`);
    }
    taskArns.push(...response.tasks.map((task) => task.taskArn));
  }
  return taskArns;
}

function waitForStoppedTasks(clusterName: string, taskArns: string[]): AwsTask[] {
  const deadline = Date.now() + args.timeoutMinutes * 60 * 1000;
  const latest = new Map<string, AwsTask>();

  while (Date.now() < deadline) {
    for (const chunk of chunks(taskArns, 100)) {
      const response = awsJson<DescribeTasksResponse>([
        'ecs',
        'describe-tasks',
        '--cluster',
        clusterName,
        '--tasks',
        ...chunk,
        '--include',
        'TAGS',
      ]);
      for (const task of response.tasks) {
        latest.set(task.taskArn, task);
      }
    }

    const stopped = taskArns.every((arn) => latest.get(arn)?.lastStatus === 'STOPPED');
    if (stopped) {
      return taskArns.map((arn) => latest.get(arn)).filter((task): task is AwsTask => task !== undefined);
    }

    sleep(args.pollSeconds * 1000);
  }

  throw new Error(`Timed out waiting for ${taskArns.length} tasks in ${clusterName}`);
}

interface Ec2Context {
  ec2InstanceId?: string;
  ecsRegisteredAt?: string;
  ec2LaunchTime?: string;
}

function loadEc2Context(clusterName: string, tasks: AwsTask[]): Map<string, Ec2Context> {
  const containerInstanceArns = unique(tasks.map((task) => task.containerInstanceArn).filter(isString));
  const byContainerInstance = new Map<string, Ec2Context>();
  const instanceIds: string[] = [];

  for (const chunk of chunks(containerInstanceArns, 100)) {
    const response = awsJson<DescribeContainerInstancesResponse>([
      'ecs',
      'describe-container-instances',
      '--cluster',
      clusterName,
      '--container-instances',
      ...chunk,
    ]);
    for (const containerInstance of response.containerInstances) {
      const context: Ec2Context = {
        ec2InstanceId: containerInstance.ec2InstanceId,
        ecsRegisteredAt: containerInstance.registeredAt,
      };
      byContainerInstance.set(containerInstance.containerInstanceArn, context);
      if (containerInstance.ec2InstanceId) {
        instanceIds.push(containerInstance.ec2InstanceId);
      }
    }
  }

  const launchTimes = loadEc2LaunchTimes(unique(instanceIds));
  for (const context of byContainerInstance.values()) {
    if (context.ec2InstanceId) {
      context.ec2LaunchTime = launchTimes.get(context.ec2InstanceId);
    }
  }

  return byContainerInstance;
}

function loadEc2LaunchTimes(instanceIds: string[]): Map<string, string> {
  const launchTimes = new Map<string, string>();
  for (const chunk of chunks(instanceIds, 100)) {
    const response = awsJson<DescribeInstancesResponse>(['ec2', 'describe-instances', '--instance-ids', ...chunk]);
    for (const reservation of response.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId && instance.LaunchTime) {
          launchTimes.set(instance.InstanceId, instance.LaunchTime);
        }
      }
    }
  }
  return launchTimes;
}

function toTaskRecord(
  runIdValue: string,
  target: TargetName,
  entry: ManifestEntry,
  task: AwsTask,
  ec2Context: Map<string, Ec2Context>,
): TaskRecord {
  const container = task.containers?.find((candidate) => candidate.name === 'workload') ?? task.containers?.[0];
  const context = task.containerInstanceArn ? ec2Context.get(task.containerInstanceArn) : undefined;
  return {
    runId: runIdValue,
    target,
    cpuArchitecture: entry.cpuArchitecture,
    imageSize: entry.imageSize,
    compression: entry.compression,
    sociMode: entry.sociMode,
    imageTag: entry.imageTag,
    taskArn: task.taskArn,
    clusterArn: task.clusterArn,
    taskDefinitionArn: task.taskDefinitionArn,
    containerInstanceArn: task.containerInstanceArn,
    ec2InstanceId: context?.ec2InstanceId,
    lastStatus: task.lastStatus,
    desiredStatus: task.desiredStatus,
    stopCode: task.stopCode,
    stoppedReason: task.stoppedReason,
    launchType: task.launchType,
    capacityProviderName: task.capacityProviderName,
    availabilityZone: task.availabilityZone,
    connectivityAt: task.connectivityAt,
    createdAt: task.createdAt,
    pullStartedAt: task.pullStartedAt,
    pullStoppedAt: task.pullStoppedAt,
    startedAt: task.startedAt,
    executionStoppedAt: task.executionStoppedAt,
    stoppedAt: task.stoppedAt,
    containerName: container?.name,
    containerImage: container?.image,
    containerImageDigest: container?.imageDigest,
    containerRuntimeId: container?.runtimeId,
    containerLastStatus: container?.lastStatus,
    containerExitCode: container?.exitCode,
    containerReason: container?.reason,
    ecsRegisteredAt: context?.ecsRegisteredAt,
    ec2LaunchTime: context?.ec2LaunchTime,
    durationsMs: {
      createdToPullStart: diffMs(task.createdAt, task.pullStartedAt),
      imagePull: diffMs(task.pullStartedAt, task.pullStoppedAt),
      pullStopToStarted: diffMs(task.pullStoppedAt, task.startedAt),
      createdToStarted: diffMs(task.createdAt, task.startedAt),
      createdToStopped: diffMs(task.createdAt, task.stoppedAt),
      startedToStopped: diffMs(task.startedAt, task.stoppedAt),
      ec2LaunchToEcsRegistered: diffMs(context?.ec2LaunchTime, context?.ecsRegisteredAt),
      ec2LaunchToTaskCreated: diffMs(context?.ec2LaunchTime, task.createdAt),
      ecsRegisteredToTaskCreated: diffMs(context?.ecsRegisteredAt, task.createdAt),
    },
  };
}

interface SummaryRow {
  target: TargetName;
  cpuArchitecture: CpuArch;
  imageSize: ImageSize;
  compression: Compression;
  sociMode: SociMode;
  metric: string;
  n: number;
  mean: number | null;
  ci95: number | null;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

function summarize(taskRecords: TaskRecord[]): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const keys = unique(taskRecords.map((record) =>
    `${record.target}|${record.cpuArchitecture}|${record.imageSize}|${record.compression}|${record.sociMode}`
  ));
  const metrics = [
    'createdToPullStart',
    'imagePull',
    'pullStopToStarted',
    'createdToStarted',
    'createdToStopped',
    'startedToStopped',
    'ec2LaunchToEcsRegistered',
    'ec2LaunchToTaskCreated',
    'ecsRegisteredToTaskCreated',
  ];

  for (const key of keys) {
    const [target, cpuArchitecture, imageSize, compression, sociMode] = key.split('|') as [
      TargetName,
      CpuArch,
      ImageSize,
      Compression,
      SociMode,
    ];
    const group = taskRecords.filter((record) =>
      record.target === target
      && record.cpuArchitecture === cpuArchitecture
      && record.imageSize === imageSize
      && record.compression === compression
      && record.sociMode === sociMode
    );
    for (const metric of metrics) {
      rows.push({
        target,
        cpuArchitecture,
        imageSize,
        compression,
        sociMode,
        metric,
        ...describe(group.map((record) => record.durationsMs[metric])),
      });
    }
  }
  return rows;
}

function describe(values: Array<number | null | undefined>) {
  const samples = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  samples.sort((a, b) => a - b);
  if (samples.length === 0) {
    return { n: 0, mean: null, ci95: null, min: null, p50: null, p90: null, p95: null, max: null };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.length > 1
    ? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1)
    : 0;
  const ci95 = samples.length > 1 ? 1.96 * Math.sqrt(variance) / Math.sqrt(samples.length) : 0;
  return {
    n: samples.length,
    mean: round(mean),
    ci95: round(ci95),
    min: round(samples[0]),
    p50: round(percentile(samples, 0.50)),
    p90: round(percentile(samples, 0.90)),
    p95: round(percentile(samples, 0.95)),
    max: round(samples[samples.length - 1]),
  };
}

function percentile(sortedSamples: number[], quantile: number): number {
  if (sortedSamples.length === 1) {
    return sortedSamples[0];
  }
  const position = (sortedSamples.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedSamples[lower];
  }
  const weight = position - lower;
  return sortedSamples[lower] * (1 - weight) + sortedSamples[upper] * weight;
}

function writeIntermediate(taskRecords: TaskRecord[]) {
  writeFileSync(join(outDir, 'tasks.jsonl'), taskRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function writeOutputs(taskRecords: TaskRecord[], summaryRows: SummaryRow[]) {
  writeIntermediate(taskRecords);
  writeFileSync(join(outDir, 'tasks.csv'), toCsv(taskRecords.map(flattenRecord)));
  writeFileSync(join(outDir, 'summary.csv'), toCsv(summaryRows));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summaryRows, null, 2));
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({
    runId,
    args,
    stackName: args.stackName,
    outputs,
    startedAt,
    taskRecords: taskRecords.length,
  }, null, 2));
}

function flattenRecord(record: TaskRecord): Record<string, unknown> {
  return {
    ...record,
    durationsMs: undefined,
    ...Object.fromEntries(Object.entries(record.durationsMs).map(([key, value]) => [`${key}Ms`, value])),
  };
}

function toCsv<T extends object>(rows: T[]): string {
  if (rows.length === 0) {
    return '';
  }
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell((row as Record<string, unknown>)[header])).join(',')),
  ].join('\n') + '\n';
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function getStackOutputs(stackName: string, region?: string): StackOutputs {
  const response = awsJson<DescribeStacksResponse>([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
  ], region);
  const outputs = Object.fromEntries((response.Stacks[0].Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));
  return outputs as unknown as StackOutputs;
}

function awsJson<T>(command: string[], region = args.region): T {
  const finalCommand = region ? [...command, '--region', region] : command;
  const result = spawnSync('aws', [...finalCommand, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`aws ${finalCommand.join(' ')} failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

function diffMs(start?: string, end?: string): number | null {
  if (!start || !end) {
    return null;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return endMs - startMs;
}

function chunks<T>(values: T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface RunTaskResponse {
  tasks: AwsTask[];
  failures?: Array<Record<string, unknown>>;
}

interface DescribeTasksResponse {
  tasks: AwsTask[];
  failures?: Array<Record<string, unknown>>;
}

interface AwsTask {
  taskArn: string;
  clusterArn?: string;
  taskDefinitionArn?: string;
  containerInstanceArn?: string;
  lastStatus?: string;
  desiredStatus?: string;
  stopCode?: string;
  stoppedReason?: string;
  launchType?: string;
  capacityProviderName?: string;
  availabilityZone?: string;
  connectivityAt?: string;
  createdAt?: string;
  pullStartedAt?: string;
  pullStoppedAt?: string;
  startedAt?: string;
  executionStoppedAt?: string;
  stoppedAt?: string;
  containers?: AwsContainer[];
}

interface AwsContainer {
  name?: string;
  image?: string;
  imageDigest?: string;
  runtimeId?: string;
  lastStatus?: string;
  exitCode?: number;
  reason?: string;
}

interface DescribeContainerInstancesResponse {
  containerInstances: Array<{
    containerInstanceArn: string;
    ec2InstanceId?: string;
    registeredAt?: string;
  }>;
}

interface DescribeInstancesResponse {
  Reservations?: Array<{
    Instances?: Array<{
      InstanceId?: string;
      LaunchTime?: string;
    }>;
  }>;
}

interface DescribeStacksResponse {
  Stacks: Array<{
    Outputs?: Array<{
      OutputKey: string;
      OutputValue: string;
    }>;
  }>;
}
