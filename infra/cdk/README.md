# Cartographer Backend CDK Infrastructure

AWS CDK (TypeScript) stack for deploying the Cartographer backend on ECS Fargate.

## Architecture

```
Internet → ALB (HTTPS:443) → ECS Fargate (port 8080) → EFS (Project M36 data)
                                  ↓
                            Supabase PostgreSQL (external)
                            OpenRouter API (external)
```

### Resources

- **VPC**: 2 AZs, public + private subnets, 1 NAT gateway
- **ECS Fargate**: ARM64, 1 vCPU / 2GB memory, auto-scaling (1–2 tasks)
- **EFS**: Encrypted file system for Project M36 event store (`/m36-data`)
- **ALB**: HTTPS termination (port 443), HTTP→HTTPS redirect
- **ECR**: Container image repository (`cartographer-backend`)

## Prerequisites

- Node.js >= 18
- AWS CLI configured with credentials
- CDK bootstrapped in the target account/region:
  ```bash
  npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-1
  ```
- ACM certificate ARN for your domain (for HTTPS)

## Setup

```bash
cd infra/cdk
yarn install
```

## Commands

| Command | Description |
|---------|-------------|
| `yarn cdk synth` | Generate CloudFormation template (dry run) |
| `yarn cdk diff` | Show pending changes vs deployed stack |
| `yarn cdk deploy` | Deploy the stack to AWS |
| `yarn cdk destroy` | Tear down the stack |

## Configuration

### ACM Certificate (required for HTTPS)

Pass your ACM certificate ARN via context:

```bash
yarn cdk deploy -c certificateArn=arn:aws:acm:ap-northeast-1:ACCOUNT:certificate/CERT_ID
```

Without a certificate, the ALB listener on port 443 uses HTTP (useful for initial testing only).

### Environment Variables

The ECS task is configured with:

| Variable | Default | Description |
|----------|---------|-------------|
| `M36_DATA_PATH` | `/app/.m36-data` | Path to Project M36 data directory (EFS mount) |

To add more environment variables (e.g., `DATABASE_URL`), edit the `environment` block in `lib/backend-stack.ts`.

## Deploying a Container Image

1. Build and push your image to the ECR repository:

   ```bash
   # Get the ECR URI from stack outputs
   ECR_URI=$(aws cloudformation describe-stacks \
     --stack-name CartographerBackendStack \
     --query 'Stacks[0].Outputs[?OutputKey==`EcrRepositoryUri`].OutputValue' \
     --output text)

   # Login to ECR
   aws ecr get-login-password --region ap-northeast-1 | \
     docker login --username AWS --password-stdin "$ECR_URI"

   # Build and push (ARM64)
   docker buildx build --platform linux/arm64 -t "$ECR_URI:latest" --push .
   ```

2. Force a new deployment to pick up the latest image:

   ```bash
   aws ecs update-service \
     --cluster cartographer-cluster \
     --service CartographerBackendStack-BackendService \
     --force-new-deployment
   ```

## Stack Outputs

After deployment, the following values are available:

| Output | Description |
|--------|-------------|
| `AlbDnsName` | ALB DNS name (point your domain's CNAME here) |
| `EcrRepositoryUri` | ECR repository URI for pushing images |
| `EfsFileSystemId` | EFS file system ID |

View outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name CartographerBackendStack \
  --query 'Stacks[0].Outputs'
```
