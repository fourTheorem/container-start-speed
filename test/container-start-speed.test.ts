import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ContainerStartSpeedStack } from '../lib/container-start-speed-stack';

test('creates benchmark repositories, clusters, capacity providers, and task definitions', () => {
  const app = new cdk.App({
    context: {
      benchmarkName: 'test-css',
      vpcId: 'vpc-1234567890abcdef0',
      subnetIds: 'subnet-11111111111111111,subnet-22222222222222222',
      maxEc2Instances: 4,
    },
  });
  const stack = new ContainerStartSpeedStack(app, 'TestStack', {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
  });

  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::ECR::Repository', 1);
  template.resourceCountIs('AWS::EC2::VPC', 0);
  template.resourceCountIs('AWS::ECS::Cluster', 5);
  template.resourceCountIs('AWS::ECS::CapacityProvider', 4);
  template.resourceCountIs('AWS::ECS::TaskDefinition', 40);

  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'test-css-images',
  });

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'test-css-x86_64-small-gzip-plain-fargate',
    RequiresCompatibilities: ['FARGATE'],
    Cpu: '1024',
    Memory: '2048',
    RuntimePlatform: {
      CpuArchitecture: 'X86_64',
      OperatingSystemFamily: 'LINUX',
    },
  });

  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'test-css-arm64-large-uncompressed-soci-ec2',
    NetworkMode: 'bridge',
    RuntimePlatform: {
      CpuArchitecture: 'ARM64',
      OperatingSystemFamily: 'LINUX',
    },
  });

  template.resourcePropertiesCountIs('AWS::ECS::TaskDefinition', {
    Family: 'test-css-arm64-large-zstd-soci-ec2',
  }, 0);
});
