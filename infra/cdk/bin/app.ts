#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BackendStack } from "../lib/backend-stack";

const app = new cdk.App();

const domainName = app.node.tryGetContext("domainName");
if (!domainName) {
  throw new Error("domainName context is required: cdk deploy -c domainName=api.example.com");
}

new BackendStack(app, "CartographerBackendStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1",
  },
  domainName,
});
