import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface BackendStackProps extends cdk.StackProps {
  certificateArn?: string;
}

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BackendStackProps) {
    super(scope, id, props);

    // --- Networking ---
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // --- ECR Repository ---
    const repository = new ecr.Repository(this, "BackendRepo", {
      repositoryName: "cartographer-backend",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: "Keep only 10 images",
        },
      ],
    });

    // --- EFS ---
    const fileSystem = new efs.FileSystem(this, "M36FileSystem", {
      vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const accessPoint = fileSystem.addAccessPoint("M36AccessPoint", {
      path: "/m36-data",
      createAcl: {
        ownerGid: "1000",
        ownerUid: "1000",
        permissions: "755",
      },
      posixUser: {
        gid: "1000",
        uid: "1000",
      },
    });

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "cartographer-cluster",
    });

    // --- Task Definition ---
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "BackendTaskDef",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      }
    );

    taskDefinition.addVolume({
      name: "m36-data",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    });

    const container = taskDefinition.addContainer("backend", {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "cartographer-backend",
      }),
      portMappings: [
        {
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
      environment: {
        // EFS マウントポイントのサブディレクトリを指定する。
        // Project M36 の CrashSafePersistence は createDirectory を呼ぶため、
        // マウントポイント自体を指定すると "already exists" エラーになる。
        M36_DATA_PATH: "/app/m36-volume/data",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:8080/health || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addMountPoints({
      containerPath: "/app/m36-volume",
      sourceVolume: "m36-data",
      readOnly: false,
    });

    // Grant EFS access to the task role
    fileSystem.grantRootAccess(taskDefinition.taskRole);
    fileSystem.connections.allowDefaultPortFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock)
    );

    // --- ALB ---
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // HTTP listener - redirect to HTTPS
    alb.addListener("HttpListener", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // HTTPS listener
    const certificateArn = props?.certificateArn ?? this.node.tryGetContext("certificateArn");
    const httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      certificates: certificateArn
        ? [
            elbv2.ListenerCertificate.fromArn(certificateArn),
          ]
        : undefined,
      // When no certificate is provided, use HTTP on 443 for initial setup
      protocol: certificateArn
        ? elbv2.ApplicationProtocol.HTTPS
        : elbv2.ApplicationProtocol.HTTP,
    });

    // --- ECS Service ---
    const service = new ecs.FargateService(this, "BackendService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Allow EFS access from the service
    fileSystem.connections.allowDefaultPortFrom(service);

    httpsListener.addTargets("BackendTarget", {
      port: 8080,
      targets: [service],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: "200",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Auto-scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 2,
    });

    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS Name",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "ECR Repository URI",
    });

    new cdk.CfnOutput(this, "EfsFileSystemId", {
      value: fileSystem.fileSystemId,
      description: "EFS File System ID",
    });
  }
}
