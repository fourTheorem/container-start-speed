import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs as parseNodeArgs } from 'util';

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
  resume?: string;
  targets: TargetName[];
  architectures: CpuArch[];
  sizes: ImageSize[];
  compressions: Compression[];
  sociModes: SociMode[];
  includeEc2Soci: boolean;
  leaveTimedOutTasks: boolean;
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
  LogGroupName?: string;
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
  benchmarkError?: string;
  runtimeSnapshotter?: string;
  workloadDependencyProfile?: string;
  workloadCommonDependencyMs?: number;
  workloadLargeDependencyMs?: number;
  workloadTotalProcessMs?: number;
  workloadMetadataAvailable?: boolean;
  workloadMetadataError?: string;
  workloadLogStreamName?: string;
  ecsRegisteredAt?: string;
  ec2LaunchTime?: string;
  durationsMs: Record<string, number | null>;
}

const args = parseArgsOrExit(process.argv.slice(2));
const runState = loadRunState(args);
const { runId, startedAt, outDir } = runState;
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

const records: TaskRecord[] = [...runState.records];
writeRunMetadata(records.length);
for (const target of targets) {
  for (const entry of selectedManifest) {
    if (target.cpuArchitecture !== entry.cpuArchitecture) {
      continue;
    }
    if (target.name !== 'fargate' && entry.sociMode === 'soci' && !args.includeEc2Soci) {
      continue;
    }
    const completedCount = countCompleted(records, target.name, entry);
    if (completedCount >= args.taskCount) {
      console.log(`Skipping ${target.name} ${entry.cpuArchitecture}/${entry.imageSize}/${entry.compression}/${entry.sociMode} (${completedCount}/${args.taskCount} successful)`);
      continue;
    }
    if (completedCount > 0) {
      console.log(`Re-running incomplete ${target.name} ${entry.cpuArchitecture}/${entry.imageSize}/${entry.compression}/${entry.sociMode} (${completedCount}/${args.taskCount} successful records found)`);
    }
    const remainingCount = args.taskCount - completedCount;
    console.log(`Running ${target.name} ${entry.cpuArchitecture}/${entry.imageSize}/${entry.compression}/${entry.sociMode} (${remainingCount} tasks)`);
    const taskArns = launchTasks(target, entry, remainingCount, runId, subnets, securityGroups);
    const waitResult = waitForStoppedTasks(target.clusterName, taskArns);
    if (waitResult.timedOut) {
      console.warn(`Timed out waiting for ${waitResult.timedOutTaskArns.length}/${taskArns.length} tasks in ${target.clusterName}`);
    }
    const ec2Context = target.name === 'fargate' ? new Map<string, Ec2Context>() : loadEc2Context(target.clusterName, waitResult.tasks);
    const workloadOutputs = loadWorkloadOutputs(outputs.LogGroupName, runId, waitResult.tasks);
    const timedOutTaskArns = new Set(waitResult.timedOutTaskArns);
    for (const task of waitResult.tasks) {
      records.push(toTaskRecord(
        runId,
        target.name,
        entry,
        task,
        ec2Context,
        workloadOutputs.get(task.taskArn),
        timedOutTaskArns.has(task.taskArn) ? `Timed out after ${args.timeoutMinutes} minutes waiting for task to stop` : undefined,
      ));
    }
    writeIntermediate(records);
    writeRunMetadata(records.length);
  }
}

const summaryRows = summarize(records);
writeOutputs(records, summaryRows);
console.log(`Wrote ${records.length} task records to ${outDir}`);

function parseArgsOrExit(argv: string[]): Args {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run with --help to see available options.');
    process.exit(1);
  }
}

function parseArgs(argv: string[]): Args {
  const { values } = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      stack: { type: 'string' },
      region: { type: 'string' },
      'task-count': { type: 'string' },
      'batch-size': { type: 'string' },
      out: { type: 'string' },
      resume: { type: 'string' },
      targets: { type: 'string' },
      architectures: { type: 'string' },
      sizes: { type: 'string' },
      compressions: { type: 'string' },
      soci: { type: 'string' },
      'poll-seconds': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      'include-ec2-soci': { type: 'boolean' },
      'leave-timed-out-tasks': { type: 'boolean' },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    stackName: values.stack ?? 'ContainerStartSpeedStack',
    region: values.region,
    taskCount: parsePositiveInteger(values['task-count'], 30, 'task-count'),
    batchSize: parsePositiveInteger(values['batch-size'], 10, 'batch-size'),
    outDir: values.out ?? 'results',
    pollSeconds: parsePositiveInteger(values['poll-seconds'], 10, 'poll-seconds'),
    timeoutMinutes: parsePositiveInteger(values['timeout-minutes'], 60, 'timeout-minutes'),
    resume: values.resume,
    targets: parseList<TargetName>(
      values.targets,
      ['fargate', 'ec2-amazon-linux', 'ec2-bottlerocket'],
      'targets',
    ),
    architectures: parseList<CpuArch>(values.architectures, ['x86_64', 'arm64'], 'architectures'),
    sizes: parseList<ImageSize>(values.sizes, ['small', 'large'], 'sizes'),
    compressions: parseList<Compression>(values.compressions, ['gzip', 'zstd', 'uncompressed'], 'compressions'),
    sociModes: parseList<SociMode>(values.soci, ['plain', 'soci'], 'soci'),
    includeEc2Soci: values['include-ec2-soci'] ?? false,
    leaveTimedOutTasks: values['leave-timed-out-tasks'] ?? false,
  };
}

function printHelp() {
  console.log(`Run the ECS container start speed benchmark.

Usage:
  npm run benchmark -- [options]

Options:
  -h, --help                              Show this help.
      --stack <name>                      CloudFormation stack name. Default: ContainerStartSpeedStack
      --region <region>                   AWS region. Defaults to AWS CLI/environment resolution.
      --task-count <count>                Successful task samples per permutation. Default: 30
      --batch-size <count>                Tasks to launch per RunTask call. Default: 10
      --targets <csv|all>                 fargate,ec2-amazon-linux,ec2-bottlerocket. Default: all
      --architectures <csv|all>           x86_64,arm64. Default: all
      --sizes <csv|all>                   small,large. Default: all
      --compressions <csv|all>            gzip,zstd,uncompressed. Default: all
      --soci <csv|all>                    plain,soci. Default: all for Fargate, plain only for EC2
      --include-ec2-soci                  Also run EC2 SOCI permutations. Default: false
      --leave-timed-out-tasks             Do not stop benchmark tasks that exceed --timeout-minutes.
      --out <dir>                         Results parent directory. Default: results
      --resume <latest|dir>               Resume an interrupted run.
      --poll-seconds <seconds>            ECS describe polling interval. Default: 10
      --timeout-minutes <minutes>         Wait timeout per launched batch. Default: 60

Examples:
  npm run benchmark -- --task-count 5 --targets fargate --architectures arm64
  npm run benchmark -- --resume latest
`);
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, optionName: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${optionName} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parseList<T extends string>(value: string | undefined, allowedValues: T[], optionName: string): T[] {
  if (!value || value === 'all') {
    return allowedValues;
  }
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = parsed.filter((item) => !allowedValues.includes(item as T));
  if (invalid.length > 0) {
    throw new Error(`--${optionName} contains invalid value(s): ${invalid.join(', ')}. Allowed: ${allowedValues.join(', ')}`);
  }
  if (parsed.length === 0) {
    throw new Error(`--${optionName} must not be empty`);
  }
  return parsed as T[];
}

interface RunState {
  runId: string;
  startedAt: string;
  outDir: string;
  records: TaskRecord[];
}

function loadRunState(parsedArgs: Args): RunState {
  if (!parsedArgs.resume) {
    const newStartedAt = new Date().toISOString();
    const newRunId = `ecs-start-${newStartedAt.replace(/[:.]/g, '-')}`;
    return {
      runId: newRunId,
      startedAt: newStartedAt,
      outDir: join(parsedArgs.outDir, newRunId),
      records: [],
    };
  }

  const resumeDir = resolveResumeDir(parsedArgs.resume, parsedArgs.outDir);
  const loadedRecords = loadTaskRecords(resumeDir);
  const metadata = loadRunMetadata(resumeDir);
  const resumeRunId = metadata?.runId ?? resumeDir.split('/').filter(Boolean).pop() ?? parsedArgs.resume;
  const resumeStartedAt = metadata?.startedAt ?? new Date().toISOString();
  console.log(`Resuming ${resumeRunId} from ${resumeDir} with ${loadedRecords.length} existing task records`);
  return {
    runId: resumeRunId,
    startedAt: resumeStartedAt,
    outDir: resumeDir,
    records: loadedRecords,
  };
}

function resolveResumeDir(resume: string, baseOutDir: string): string {
  if (resume === 'latest') {
    const latest = findLatestRunDir(baseOutDir);
    if (!latest) {
      throw new Error(`No previous runs found in ${baseOutDir}`);
    }
    return latest;
  }

  const directPath = resolve(resume);
  if (existsSync(directPath) && statSync(directPath).isDirectory()) {
    return directPath;
  }

  const nestedPath = resolve(baseOutDir, resume);
  if (existsSync(nestedPath) && statSync(nestedPath).isDirectory()) {
    return nestedPath;
  }

  throw new Error(`Resume target not found: ${resume}`);
}

function findLatestRunDir(baseOutDir: string): string | undefined {
  const resolvedBase = resolve(baseOutDir);
  if (!existsSync(resolvedBase)) {
    return undefined;
  }
  return readdirSync(resolvedBase)
    .map((name) => join(resolvedBase, name))
    .filter((path) => existsSync(join(path, 'tasks.jsonl')) || existsSync(join(path, 'run.json')))
    .filter((path) => statSync(path).isDirectory())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function loadTaskRecords(runDirectory: string): TaskRecord[] {
  const taskRecordsPath = join(runDirectory, 'tasks.jsonl');
  if (!existsSync(taskRecordsPath)) {
    return [];
  }
  const content = readFileSync(taskRecordsPath, 'utf8').trim();
  if (!content) {
    return [];
  }
  return content.split('\n').map((line) => JSON.parse(line) as TaskRecord);
}

function loadRunMetadata(runDirectory: string): { runId?: string; startedAt?: string } | undefined {
  const metadataPath = join(runDirectory, 'run.json');
  if (!existsSync(metadataPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(metadataPath, 'utf8')) as { runId?: string; startedAt?: string };
}

function countCompleted(recordsToCheck: TaskRecord[], target: TargetName, entry: ManifestEntry): number {
  return recordsToCheck.filter((record) =>
    record.target === target
    && record.cpuArchitecture === entry.cpuArchitecture
    && record.imageSize === entry.imageSize
    && record.compression === entry.compression
    && record.sociMode === entry.sociMode
    && isSuccessfulBenchmarkRecord(record)
  ).length;
}

function isSuccessfulBenchmarkRecord(record: TaskRecord): boolean {
  return record.containerExitCode === 0
    && typeof record.durationsMs.createdToStarted === 'number'
    && Number.isFinite(record.durationsMs.createdToStarted);
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

interface WaitForTasksResult {
  tasks: AwsTask[];
  timedOut: boolean;
  timedOutTaskArns: string[];
}

function waitForStoppedTasks(clusterName: string, taskArns: string[]): WaitForTasksResult {
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
      return {
        tasks: taskArns.map((arn) => latest.get(arn)).filter((task): task is AwsTask => task !== undefined),
        timedOut: false,
        timedOutTaskArns: [],
      };
    }

    sleep(args.pollSeconds * 1000);
  }

  const timedOutTaskArns = taskArns.filter((arn) => latest.get(arn)?.lastStatus !== 'STOPPED');
  if (timedOutTaskArns.length > 0 && !args.leaveTimedOutTasks) {
    stopTimedOutTasks(clusterName, timedOutTaskArns);
  }

  return {
    tasks: taskArns.map((arn) => latest.get(arn) ?? ({
      taskArn: arn,
      lastStatus: 'UNKNOWN',
      stoppedReason: 'Benchmark timed out before ECS returned task details',
    })),
    timedOut: true,
    timedOutTaskArns,
  };
}

function stopTimedOutTasks(clusterName: string, taskArns: string[]) {
  for (const taskArn of taskArns) {
    try {
      awsJson([
        'ecs',
        'stop-task',
        '--cluster',
        clusterName,
        '--task',
        taskArn,
        '--reason',
        `container-start-speed timed out after ${args.timeoutMinutes} minutes`,
      ]);
    } catch (error) {
      console.warn(`Failed to stop timed-out task ${taskArn}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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

interface WorkloadOutput {
  runtimeSnapshotter?: string;
  workloadDependencyProfile?: string;
  workloadCommonDependencyMs?: number;
  workloadLargeDependencyMs?: number;
  workloadTotalProcessMs?: number;
  workloadMetadataAvailable?: boolean;
  workloadMetadataError?: string;
  workloadLogStreamName?: string;
}

interface WorkloadLogPayload {
  event?: string;
  run_id?: string;
  dependency_profile?: string;
  snapshotter?: string;
  ecs_metadata?: {
    available?: boolean;
    error?: string;
    snapshotter?: string;
  };
  common_dependency_ms?: number;
  large_dependency_ms?: number;
  total_process_ms?: number;
}

function loadWorkloadOutputs(logGroupName: string | undefined, runIdValue: string, tasks: AwsTask[]): Map<string, WorkloadOutput> {
  const outputsByTaskArn = new Map<string, WorkloadOutput>();
  if (!logGroupName || tasks.length === 0) {
    return outputsByTaskArn;
  }

  const tasksByLogStream = new Map<string, AwsTask>();
  for (const task of tasks) {
    const logStreamName = logStreamNameForTask(task);
    if (logStreamName) {
      tasksByLogStream.set(logStreamName, task);
    }
  }

  if (tasksByLogStream.size === 0) {
    return outputsByTaskArn;
  }

  const expectedTaskArns = new Set([...tasksByLogStream.values()].map((task) => task.taskArn));
  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const prefix of unique([...tasksByLogStream.keys()].map((streamName) => streamName.split('/').slice(0, 2).join('/')))) {
      let logEvents: AwsLogEvent[] = [];
      try {
        logEvents = loadLogEvents(logGroupName, prefix, tasks);
      } catch (error) {
        console.warn(`Failed to read workload logs for ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const event of logEvents) {
        const logStreamName = event.logStreamName;
        const task = logStreamName ? tasksByLogStream.get(logStreamName) : undefined;
        if (!logStreamName || !task || outputsByTaskArn.has(task.taskArn)) {
          continue;
        }
        const payload = parseWorkloadLogPayload(event.message, runIdValue);
        if (!payload) {
          continue;
        }
        outputsByTaskArn.set(task.taskArn, workloadOutputFromPayload(payload, logStreamName));
      }
    }

    if ([...expectedTaskArns].every((taskArn) => outputsByTaskArn.has(taskArn))) {
      break;
    }
    if (attempt < 4) {
      sleep(3000);
    }
  }

  return outputsByTaskArn;
}

function logStreamNameForTask(task: AwsTask): string | undefined {
  const family = task.taskDefinitionArn?.split('/').pop()?.split(':')[0];
  const taskId = task.taskArn.split('/').pop();
  if (!family || !taskId) {
    return undefined;
  }
  return `${family}/workload/${taskId}`;
}

function loadLogEvents(logGroupName: string, logStreamNamePrefix: string, tasks: AwsTask[]): AwsLogEvent[] {
  const command = [
    'logs',
    'filter-log-events',
    '--log-group-name',
    logGroupName,
    '--log-stream-name-prefix',
    logStreamNamePrefix,
  ];
  const startTime = minTimestamp(tasks.map((task) => task.createdAt), -60_000);
  const endTime = maxTimestamp(tasks.map((task) => task.stoppedAt ?? task.executionStoppedAt), 60_000);
  if (startTime !== undefined) {
    command.push('--start-time', String(startTime));
  }
  if (endTime !== undefined) {
    command.push('--end-time', String(endTime));
  }

  const events: AwsLogEvent[] = [];
  let nextToken: string | undefined;
  do {
    const response = awsJson<FilterLogEventsResponse>(nextToken ? [...command, '--next-token', nextToken] : command);
    events.push(...(response.events ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return events;
}

function parseWorkloadLogPayload(message: string | undefined, runIdValue: string): WorkloadLogPayload | undefined {
  if (!message) {
    return undefined;
  }
  try {
    const payload = JSON.parse(message) as WorkloadLogPayload;
    if (payload.event !== 'benchmark-complete' || payload.run_id !== runIdValue) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function workloadOutputFromPayload(payload: WorkloadLogPayload, logStreamName: string): WorkloadOutput {
  return {
    runtimeSnapshotter: payload.snapshotter ?? payload.ecs_metadata?.snapshotter,
    workloadDependencyProfile: payload.dependency_profile,
    workloadCommonDependencyMs: payload.common_dependency_ms,
    workloadLargeDependencyMs: payload.large_dependency_ms,
    workloadTotalProcessMs: payload.total_process_ms,
    workloadMetadataAvailable: payload.ecs_metadata?.available,
    workloadMetadataError: payload.ecs_metadata?.error,
    workloadLogStreamName: logStreamName,
  };
}

function toTaskRecord(
  runIdValue: string,
  target: TargetName,
  entry: ManifestEntry,
  task: AwsTask,
  ec2Context: Map<string, Ec2Context>,
  workloadOutput?: WorkloadOutput,
  benchmarkError?: string,
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
    benchmarkError,
    runtimeSnapshotter: workloadOutput?.runtimeSnapshotter,
    workloadDependencyProfile: workloadOutput?.workloadDependencyProfile,
    workloadCommonDependencyMs: workloadOutput?.workloadCommonDependencyMs,
    workloadLargeDependencyMs: workloadOutput?.workloadLargeDependencyMs,
    workloadTotalProcessMs: workloadOutput?.workloadTotalProcessMs,
    workloadMetadataAvailable: workloadOutput?.workloadMetadataAvailable,
    workloadMetadataError: workloadOutput?.workloadMetadataError,
    workloadLogStreamName: workloadOutput?.workloadLogStreamName,
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
  const successfulRecords = taskRecords.filter(isSuccessfulBenchmarkRecord);
  const rows: SummaryRow[] = [];
  const keys = unique(successfulRecords.map((record) =>
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
    const group = successfulRecords.filter((record) =>
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
  writeRunMetadata(taskRecords.length);
}

function writeRunMetadata(taskRecords: number) {
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({
    runId,
    args,
    stackName: args.stackName,
    outputs,
    startedAt,
    taskRecords,
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

function minTimestamp(values: Array<string | undefined>, offsetMs: number): number | undefined {
  const parsed = values
    .map((value) => value ? Date.parse(value) : NaN)
    .filter((value) => Number.isFinite(value));
  if (parsed.length === 0) {
    return undefined;
  }
  return Math.min(...parsed) + offsetMs;
}

function maxTimestamp(values: Array<string | undefined>, offsetMs: number): number | undefined {
  const parsed = values
    .map((value) => value ? Date.parse(value) : NaN)
    .filter((value) => Number.isFinite(value));
  if (parsed.length === 0) {
    return undefined;
  }
  return Math.max(...parsed) + offsetMs;
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

interface FilterLogEventsResponse {
  events?: AwsLogEvent[];
  nextToken?: string;
}

interface AwsLogEvent {
  logStreamName?: string;
  message?: string;
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
