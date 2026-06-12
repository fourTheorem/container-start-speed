#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ContainerStartSpeedStack } from '../lib/container-start-speed-stack';

const app = new cdk.App();
new ContainerStartSpeedStack(app, 'ContainerStartSpeedStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
