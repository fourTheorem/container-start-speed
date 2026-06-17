import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

type ImageSize = 'small' | 'large';
type Compression = 'gzip' | 'zstd' | 'uncompressed';
type SociMode = 'plain' | 'soci';
type CpuArch = 'x86_64' | 'arm64';

const IMAGE_SIZES: ImageSize[] = ['small', 'large'];
const IMAGE_FORMATS: { compression: Compression; sociMode: SociMode }[] = [
  { compression: 'gzip', sociMode: 'plain' },
  { compression: 'gzip', sociMode: 'soci' },
  { compression: 'zstd', sociMode: 'plain' },
  { compression: 'uncompressed', sociMode: 'plain' },
  { compression: 'uncompressed', sociMode: 'soci' },
];
const CPU_ARCHITECTURES: CpuArch[] = ['x86_64', 'arm64'];

export class ContainerStartSpeedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const benchmarkName = this.node.tryGetContext('benchmarkName') ?? 'css-bench';
    const ec2X86InstanceType = this.node.tryGetContext('ec2X86InstanceType') ?? 'm7i.large';
    const ec2ArmInstanceType = this.node.tryGetContext('ec2ArmInstanceType') ?? 'm7g.large';
    const maxEc2Instances = Number(this.node.tryGetContext('maxEc2Instances') ?? 8);
    const ec2RootVolumeGiB = Number(this.node.tryGetContext('ec2RootVolumeGiB') ?? 300);
    const fargateEphemeralStorageGiB = Number(this.node.tryGetContext('fargateEphemeralStorageGiB') ?? 100);
    const vpcId = requiredContext(this, 'vpcId');
    const subnetIds = parseCsvContext(this, 'subnetIds');
    const availabilityZones = syntheticAvailabilityZones(this.region, subnetIds.length);

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones,
      publicSubnetIds: subnetIds,
    });
    const selectedSubnets = subnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetAttributes(this, `Subnet${index + 1}`, {
        subnetId,
        availabilityZone: availabilityZones[index],
      })
    );

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      description: 'Outbound-only security group for ECS start-speed benchmark tasks',
      allowAllOutbound: true,
    });

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `${benchmarkName}-images`,
      imageScanOnPush: false,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${benchmarkName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fargateCluster = new ecs.Cluster(this, 'FargateCluster', {
      vpc,
      clusterName: `${benchmarkName}-fargate`,
      enableFargateCapacityProviders: true,
    });

    const amazonLinuxX86Cluster = this.createEc2Cluster({
      benchmarkName,
      idPrefix: 'AmazonLinuxX86',
      clusterName: `${benchmarkName}-ec2-al2023-x86-64`,
      cpuArchitecture: 'x86_64',
      vpc,
      subnets: selectedSubnets,
      instanceType: ec2X86InstanceType,
      maxEc2Instances,
      ec2RootVolumeGiB,
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
    });

    const amazonLinuxArmCluster = this.createEc2Cluster({
      benchmarkName,
      idPrefix: 'AmazonLinuxArm',
      clusterName: `${benchmarkName}-ec2-al2023-arm64`,
      cpuArchitecture: 'arm64',
      vpc,
      subnets: selectedSubnets,
      instanceType: ec2ArmInstanceType,
      maxEc2Instances,
      ec2RootVolumeGiB,
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
    });

    const bottlerocketX86Cluster = this.createEc2Cluster({
      benchmarkName,
      idPrefix: 'BottlerocketX86',
      clusterName: `${benchmarkName}-ec2-bottlerocket-x86-64`,
      cpuArchitecture: 'x86_64',
      vpc,
      subnets: selectedSubnets,
      instanceType: ec2X86InstanceType,
      maxEc2Instances,
      ec2RootVolumeGiB,
      machineImage: new ecs.BottleRocketImage({
        variant: ecs.BottlerocketEcsVariant.AWS_ECS_2,
      }),
      machineImageType: ecs.MachineImageType.BOTTLEROCKET,
    });

    const bottlerocketArmCluster = this.createEc2Cluster({
      benchmarkName,
      idPrefix: 'BottlerocketArm',
      clusterName: `${benchmarkName}-ec2-bottlerocket-arm64`,
      cpuArchitecture: 'arm64',
      vpc,
      subnets: selectedSubnets,
      instanceType: ec2ArmInstanceType,
      maxEc2Instances,
      ec2RootVolumeGiB,
      machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/bottlerocket/aws-ecs-2/arm64/latest/image_id', {
        os: ec2.OperatingSystemType.LINUX,
      }),
      machineImageType: ecs.MachineImageType.BOTTLEROCKET,
    });

    for (const cpuArchitecture of CPU_ARCHITECTURES) {
      for (const size of IMAGE_SIZES) {
        for (const imageFormat of IMAGE_FORMATS) {
          const { compression, sociMode } = imageFormat;
          const tag = imageTag(cpuArchitecture, size, compression, sociMode);
          const fargateFamily = taskFamily(benchmarkName, cpuArchitecture, size, compression, sociMode, 'fargate');
          const ec2Family = taskFamily(benchmarkName, cpuArchitecture, size, compression, sociMode, 'ec2');

          this.createFargateTaskDefinition({
            id: `Fg${pascal(cpuArchitecture)}${pascal(size)}${pascal(compression)}${pascal(sociMode)}`,
            family: fargateFamily,
            repository,
            tag,
            logGroup,
            cpuArchitecture,
            size,
            compression,
            sociMode,
            fargateEphemeralStorageGiB,
          });

          this.createEc2TaskDefinition({
            id: `Ec2${pascal(cpuArchitecture)}${pascal(size)}${pascal(compression)}${pascal(sociMode)}`,
            family: ec2Family,
            repository,
            tag,
            logGroup,
            cpuArchitecture,
            size,
            compression,
            sociMode,
          });

        }
      }
    }

    new cdk.CfnOutput(this, 'BenchmarkName', { value: benchmarkName });
    new cdk.CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'FargateClusterName', { value: fargateCluster.clusterName });
    this.addEc2ClusterOutputs('AmazonLinuxX86', amazonLinuxX86Cluster);
    this.addEc2ClusterOutputs('AmazonLinuxArm', amazonLinuxArmCluster);
    this.addEc2ClusterOutputs('BottlerocketX86', bottlerocketX86Cluster);
    this.addEc2ClusterOutputs('BottlerocketArm', bottlerocketArmCluster);
    new cdk.CfnOutput(this, 'TaskSecurityGroupId', { value: taskSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, 'SubnetIds', { value: subnetIds.join(',') });
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }

  private createEc2Cluster(props: {
    benchmarkName: string;
    idPrefix: string;
    clusterName: string;
    cpuArchitecture: CpuArch;
    vpc: ec2.IVpc;
    subnets: ec2.ISubnet[];
    instanceType: string;
    maxEc2Instances: number;
    ec2RootVolumeGiB: number;
    machineImage: ec2.IMachineImage;
    machineImageType?: ecs.MachineImageType;
  }): { cluster: ecs.Cluster; capacityProvider: ecs.AsgCapacityProvider } {
    const cluster = new ecs.Cluster(this, `${props.idPrefix}Cluster`, {
      vpc: props.vpc,
      clusterName: props.clusterName,
    });

    const asg = new autoscaling.AutoScalingGroup(this, `${props.idPrefix}Asg`, {
      vpc: props.vpc,
      vpcSubnets: { subnets: props.subnets },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: props.machineImage,
      minCapacity: 0,
      maxCapacity: props.maxEc2Instances,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(props.ec2RootVolumeGiB, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, `${props.idPrefix}CapacityProvider`, {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      targetCapacityPercent: 100,
      instanceWarmupPeriod: 60,
      machineImageType: props.machineImageType,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    cdk.Tags.of(asg).add('Benchmark', props.benchmarkName);
    cdk.Tags.of(asg).add('BenchmarkCluster', props.clusterName);
    cdk.Tags.of(asg).add('BenchmarkCpuArchitecture', props.cpuArchitecture);

    return { cluster, capacityProvider };
  }

  private addEc2ClusterOutputs(
    prefix: string,
    resources: { cluster: ecs.Cluster; capacityProvider: ecs.AsgCapacityProvider },
  ) {
    new cdk.CfnOutput(this, `${prefix}ClusterName`, { value: resources.cluster.clusterName });
    new cdk.CfnOutput(this, `${prefix}CapacityProviderName`, {
      value: resources.capacityProvider.capacityProviderName,
    });
  }

  private createFargateTaskDefinition(props: TaskDefinitionProps & { fargateEphemeralStorageGiB: number }) {
    const taskDefinition = new ecs.FargateTaskDefinition(this, props.id, {
      family: props.family,
      cpu: 1024,
      memoryLimitMiB: 2048,
      ephemeralStorageGiB: props.fargateEphemeralStorageGiB,
      runtimePlatform: {
        cpuArchitecture: ecsCpuArchitecture(props.cpuArchitecture),
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.addBenchmarkContainer(taskDefinition, props);
  }

  private createEc2TaskDefinition(props: TaskDefinitionProps) {
    const taskDefinition = new ecs.Ec2TaskDefinition(this, props.id, {
      family: props.family,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    const cfnTaskDefinition = taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDefinition.runtimePlatform = {
      cpuArchitecture: cfnCpuArchitecture(props.cpuArchitecture),
      operatingSystemFamily: 'LINUX',
    };

    this.addBenchmarkContainer(taskDefinition, props);
  }

  private addBenchmarkContainer(taskDefinition: ecs.TaskDefinition, props: TaskDefinitionProps) {
    taskDefinition.addContainer('workload', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.tag),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: props.family,
      }),
      memoryLimitMiB: 2048,
      cpu: 1024,
      environment: {
        BENCHMARK_IMAGE_TAG: props.tag,
        BENCHMARK_CPU_ARCHITECTURE: props.cpuArchitecture,
        BENCHMARK_IMAGE_SIZE: props.size,
        BENCHMARK_COMPRESSION: props.compression,
        BENCHMARK_SOCI_MODE: props.sociMode,
      },
    });
  }
}

interface TaskDefinitionProps {
  id: string;
  family: string;
  repository: ecr.IRepository;
  tag: string;
  logGroup: logs.ILogGroup;
  cpuArchitecture: CpuArch;
  size: ImageSize;
  compression: Compression;
  sociMode: SociMode;
}

function imageTag(cpuArchitecture: CpuArch, size: ImageSize, compression: Compression, sociMode: SociMode): string {
  return `${cpuArchitecture}-${size}-${compression}-${sociMode}`;
}

function taskFamily(
  benchmarkName: string,
  cpuArchitecture: CpuArch,
  size: ImageSize,
  compression: Compression,
  sociMode: SociMode,
  launchType: 'fargate' | 'ec2',
): string {
  return `${benchmarkName}-${cpuArchitecture}-${size}-${compression}-${sociMode}-${launchType}`;
}

function ecsCpuArchitecture(cpuArchitecture: CpuArch): ecs.CpuArchitecture {
  return cpuArchitecture === 'arm64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64;
}

function cfnCpuArchitecture(cpuArchitecture: CpuArch): string {
  return cpuArchitecture === 'arm64' ? 'ARM64' : 'X86_64';
}

function requiredContext(scope: Construct, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required CDK context value: -c ${key}=...`);
  }
  return value.trim();
}

function parseCsvContext(scope: Construct, key: string): string[] {
  const value = requiredContext(scope, key);
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error(`CDK context value ${key} must contain at least one comma-separated value.`);
  }
  return parsed;
}

function syntheticAvailabilityZones(region: string, count: number): string[] {
  if (cdk.Token.isUnresolved(region)) {
    throw new Error('Stack region must be configured when importing a VPC from vpcId/subnetIds context.');
  }

  const zoneSuffixes = 'abcdefghijklmnopqrstuvwxyz'.split('');
  if (count > zoneSuffixes.length) {
    throw new Error(`Cannot synthesize ${count} availability zone names.`);
  }

  return Array.from({ length: count }, (_, index) => `${region}${zoneSuffixes[index]}`);
}

function pascal(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
