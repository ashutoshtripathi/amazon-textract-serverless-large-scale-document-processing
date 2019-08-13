"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/cdk");
const events = require("@aws-cdk/aws-events");
const iam = require("@aws-cdk/aws-iam");
const aws_lambda_event_sources_1 = require("@aws-cdk/aws-lambda-event-sources");
const sns = require("@aws-cdk/aws-sns");
const sqs = require("@aws-cdk/aws-sqs");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const lambda = require("@aws-cdk/aws-lambda");
const s3 = require("@aws-cdk/aws-s3");
//import es = require('@aws-cdk/aws-lambda');
class TextractPipelineStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        //**********SNS Topics******************************
        const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');
        //**********IAM Roles******************************
        const textractServiceRole = new iam.Role(this, 'TextractServiceRole', {
            assumedBy: new iam.ServicePrincipal('textract.amazonaws.com')
        });
        textractServiceRole.addToPolicy(new iam.PolicyStatement().addResource(jobCompletionTopic.topicArn).addAction('sns:Publish'));
        //**********S3 Batch Operations Role******************************
        const s3BatchOperationsRole = new iam.Role(this, 'S3BatchOperationsRole', {
            assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com')
        });
        //**********S3 Bucket******************************
        //S3 bucket for input documents and output
        const contentBucket = new s3.Bucket(this, 'DocumentsBucket', { versioned: false });
        const existingContentBucket = new s3.Bucket(this, 'ExistingDocumentsBucket', { versioned: false });
        existingContentBucket.grantReadWrite(s3BatchOperationsRole);
        const inventoryAndLogsBucket = new s3.Bucket(this, 'InventoryAndLogsBucket', { versioned: false });
        inventoryAndLogsBucket.grantReadWrite(s3BatchOperationsRole);
        //**********DynamoDB Table*************************
        //DynamoDB table with links to output in S3
        const outputTable = new dynamodb.Table(this, 'OutputTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            sortKey: { name: 'outputType', type: dynamodb.AttributeType.String }
        });
        //DynamoDB table with links to output in S3
        const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            streamSpecification: dynamodb.StreamViewType.NewImage
        });
        //**********SQS Queues*****************************
        //DLQ
        const dlq = new sqs.Queue(this, 'DLQ', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600
        });
        //Input Queue for sync jobs
        const syncJobsQueue = new sqs.Queue(this, 'SyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Input Queue for async jobs
        const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Queue
        const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
            visibilityTimeoutSec: 900, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Trigger
        jobCompletionTopic.subscribeQueue(jobResultsQueue);
        //**********Lambda Functions******************************
        // Helper Layer with helper functions
        const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.asset('lambda/helper'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Helper layer.',
        });
        // Textractor helper layer
        const textractorLayer = new lambda.LayerVersion(this, 'Textractor', {
            code: lambda.Code.asset('lambda/textractor'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Textractor layer.',
        });
        // Textractor ElasticLayer layer
        const elasticLayer = new lambda.LayerVersion(this, 'ElasticLayer', {
            code: lambda.Code.asset('lambda/elastic'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Elastic layer.',
        });
        //------------------------------------------------------------
        // S3 Event processor
        const s3Processor = new lambda.Function(this, 'S3Processor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/s3processor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            }
        });
        //Layer
        s3Processor.addLayer(elasticLayer);
        s3Processor.addLayer(helperLayer);
        //Trigger
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.ObjectCreated]
        }));
        //Permissions
        documentsTable.grantReadWriteData(s3Processor);
        syncJobsQueue.grantSendMessages(s3Processor);
        asyncJobsQueue.grantSendMessages(s3Processor);
        //------------------------------------------------------------
        // S3 Batch Operations Event processor 
        const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/s3batchprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            },
            reservedConcurrentExecutions: 50,
        });
        //Layer
        s3BatchProcessor.addLayer(elasticLayer);
        s3BatchProcessor.addLayer(helperLayer);
        //Permissions
        documentsTable.grantReadWriteData(s3BatchProcessor);
        s3BatchProcessor.grantInvoke(s3BatchOperationsRole);
        s3BatchOperationsRole.addToPolicy(new iam.PolicyStatement().addAllResources().addActions("lambda:*"));
        //------------------------------------------------------------
        // Document processor (Router to Sync/Async Pipeline)
        const documentProcessor = new lambda.Function(this, 'TaskProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/documentprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
            }
        });
        //Layer
        documentProcessor.addLayer(elasticLayer);
        documentProcessor.addLayer(helperLayer);
        //Trigger
        documentProcessor.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(documentsTable, {
            startingPosition: lambda.StartingPosition.TrimHorizon
        }));
        //Permissions
        documentsTable.grantReadWriteData(documentProcessor);
        syncJobsQueue.grantSendMessages(documentProcessor);
        asyncJobsQueue.grantSendMessages(documentProcessor);
        //------------------------------------------------------------
        // Sync Jobs Processor (Process jobs using sync APIs)
        const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/syncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: 25,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        syncProcessor.addLayer(elasticLayer);
        syncProcessor.addLayer(helperLayer);
        syncProcessor.addLayer(textractorLayer);
        //Trigger
        syncProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(syncJobsQueue, {
            batchSize: 1
        }));
        //Permissions
        contentBucket.grantReadWrite(syncProcessor);
        existingContentBucket.grantReadWrite(syncProcessor);
        outputTable.grantReadWriteData(syncProcessor);
        documentsTable.grantReadWriteData(syncProcessor);
        syncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addActions("textract:*"));
        //------------------------------------------------------------
        // Async Job Processor (Start jobs using Async APIs)
        const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/asyncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 50,
            timeout: 60,
            environment: {
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
                SNS_ROLE_ARN: textractServiceRole.roleArn,
                AWS_DATA_PATH: "models"
            }
        });
        //asyncProcessor.addEnvironment("SNS_TOPIC_ARN", textractServiceRole.topicArn)
        //Layer
        asyncProcessor.addLayer(elasticLayer);
        asyncProcessor.addLayer(helperLayer);
        //Triggers
        // Run async job processor every 5 minutes
        const rule = new events.EventRule(this, 'Rule', {
            scheduleExpression: 'rate(2 minutes)',
        });
        rule.addTarget(asyncProcessor);
        //Run when a job is successfully complete
        asyncProcessor.addEventSource(new aws_lambda_event_sources_1.SnsEventSource(jobCompletionTopic));
        //Permissions
        contentBucket.grantRead(asyncProcessor);
        existingContentBucket.grantReadWrite(asyncProcessor);
        asyncJobsQueue.grantConsumeMessages(asyncProcessor);
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addResource(textractServiceRole.roleArn).addAction('iam:PassRole'));
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
        //------------------------------------------------------------
        // Async Jobs Results Processor
        const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/jobresultprocessor'),
            handler: 'lambda_function.lambda_handler',
            memorySize: 3000,
            reservedConcurrentExecutions: 100,
            timeout: 900,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        jobResultProcessor.addLayer(elasticLayer);
        jobResultProcessor.addLayer(helperLayer);
        jobResultProcessor.addLayer(textractorLayer);
        //Triggers
        jobResultProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(jobResultsQueue, {
            batchSize: 10
        }));
        //Permissions
        outputTable.grantReadWriteData(jobResultProcessor);
        documentsTable.grantReadWriteData(jobResultProcessor);
        contentBucket.grantReadWrite(jobResultProcessor);
        existingContentBucket.grantReadWrite(jobResultProcessor);
        jobResultProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
    }
}
exports.TextractPipelineStack = TextractPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGV4dHJhY3QtcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0ZXh0cmFjdC1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG9DQUFxQztBQUNyQyw4Q0FBK0M7QUFDL0Msd0NBQXlDO0FBQ3pDLGdGQUFxSDtBQUNySCx3Q0FBeUM7QUFDekMsd0NBQXlDO0FBQ3pDLGtEQUFtRDtBQUNuRCw4Q0FBK0M7QUFDL0Msc0NBQXVDO0FBQ3ZDLDZDQUE2QztBQUc3QyxNQUFhLHFCQUFzQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBRWxELFlBQVksS0FBb0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDbEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsb0RBQW9EO1FBQ3BELE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxlQUFlLENBQUMsQ0FBQztRQUVoRSxtREFBbUQ7UUFDbkQsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQ3BFLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyx3QkFBd0IsQ0FBQztTQUM5RCxDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUMsV0FBVyxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO1FBRTdILGtFQUFrRTtRQUNsRSxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDeEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGtDQUFrQyxDQUFDO1NBQ3hFLENBQUMs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Q0FBQyxDQUFDO1FBQ0osYUFBYTtRQUNiLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFBO1FBQ2xELGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFBO1FBQ3JELGFBQWEsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUNoRCxxQkFBcUIsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUN4RCxrQkFBa0IsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUMsZUFBZSxFQUFFLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUE7SUFDekcsQ0FBQztDQUNGO0FBclFELHNEQXFRQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjZGsgPSByZXF1aXJlKCdAYXdzLWNkay9jZGsnKTtcbmltcG9ydCBldmVudHMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtZXZlbnRzJyk7XG5pbXBvcnQgaWFtID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWlhbScpO1xuaW1wb3J0IHsgUzNFdmVudFNvdXJjZSwgU3FzRXZlbnRTb3VyY2UsIFNuc0V2ZW50U291cmNlLCBEeW5hbW9FdmVudFNvdXJjZSB9IGZyb20gJ0Bhd3MtY2RrL2F3cy1sYW1iZGEtZXZlbnQtc291cmNlcyc7XG5pbXBvcnQgc25zID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNucycpO1xuaW1wb3J0IHNxcyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zcXMnKTtcbmltcG9ydCBkeW5hbW9kYiA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1keW5hbW9kYicpO1xuaW1wb3J0IGxhbWJkYSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1sYW1iZGEnKTtcbmltcG9ydCBzMyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zMycpO1xuLy9pbXBvcnQgZXMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5cblxuZXhwb3J0IGNsYXNzIFRleHRyYWN0UGlwZWxpbmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vKioqKioqKioqKlNOUyBUb3BpY3MqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBqb2JDb21wbGV0aW9uVG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdKb2JDb21wbGV0aW9uJyk7XG5cbiAgICAvLyoqKioqKioqKipJQU0gUm9sZXMqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCB0ZXh0cmFjdFNlcnZpY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUZXh0cmFjdFNlcnZpY2VSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ3RleHRyYWN0LmFtYXpvbmF3cy5jb20nKVxuICAgIH0pO1xuICAgIHRleHRyYWN0U2VydmljZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoKS5hZGRSZXNvdXJjZShqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm4pLmFkZEFjdGlvbignc25zOlB1Ymxpc2gnKSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCYXRjaCBPcGVyYXRpb25zIFJvbGUqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBzM0JhdGNoT3BlcmF0aW9uc1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1MzQmF0Y2hPcGVyYXRpb25zUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiYXRjaG9wZXJhdGlvbnMuczMuYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCdWNrZXQqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL1MzIGJ1Y2tldCBmb3IgaW5wdXQgZG9jdW1lbnRzIGFuZCBvdXRwdXRcbiAgICBjb25zdCBjb250ZW50QnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnRG9jdW1lbnRzQnVja2V0JywgeyB2ZXJzaW9uZWQ6IGZhbHNlfSk7XG5cbiAgICBjb25zdCBleGlzdGluZ0NvbnRlbnRCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdFeGlzdGluZ0RvY3VtZW50c0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzM0JhdGNoT3BlcmF0aW9uc1JvbGUpXG5cbiAgICBjb25zdCBpbnZlbnRvcnlBbmRMb2dzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnSW52ZW50b3J5QW5kTG9nc0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xuICAgIGludmVudG9yeUFuZExvZ3NCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoczNCYXRjaE9wZXJhdGlvbnNSb2xlKVxuXG4gICAgLy8qKioqKioqKioqRHluYW1vREIgVGFibGUqKioqKioqKioqKioqKioqKioqKioqKioqXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IG91dHB1dFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdPdXRwdXRUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU3RyaW5nIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdvdXRwdXRUeXBlJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TdHJpbmcgfVxuICAgIH0pO1xuXG4gICAgLy9EeW5hbW9EQiB0YWJsZSB3aXRoIGxpbmtzIHRvIG91dHB1dCBpbiBTM1xuICAgIGNvbnN0IGRvY3VtZW50c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEb2N1bWVudHNUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9jdW1lbnRJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU3RyaW5nIH0sXG4gICAgICBzdHJlYW1TcGVjaWZpY2F0aW9uOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5OZXdJbWFnZVxuICAgIH0pO1xuXG4gICAgLy8qKioqKioqKioqU1FTIFF1ZXVlcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqXG5cbiAgICAvL0RMUVxuICAgIGNvbnN0IGRscSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0RMUScsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0U2VjOiAzMCwgcmV0ZW50aW9uUGVyaW9kU2VjOiAxMjA5NjAwXG4gICAgfSk7XG5cbiAgICAvL0lucHV0IFF1ZXVlIGZvciBzeW5jIGpvYnNcbiAgICBjb25zdCBzeW5jSm9ic1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnU3luY0pvYnMnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dFNlYzogMzAsIHJldGVudGlvblBlcmlvZFNlYzogMTIwOTYwMCwgZGVhZExldHRlclF1ZXVlIDogeyBxdWV1ZTogZGxxLCBtYXhSZWNlaXZlQ291bnQ6IDUwfVxuICAgIH0pO1xuXG4gICAgLy9JbnB1dCBRdWV1ZSBmb3IgYXN5bmMgam9ic1xuICAgIGNvbnN0IGFzeW5jSm9ic1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnQXN5bmNKb2JzJywge1xuICAgICAgdmlzaWJpbGl0eVRpbWVvdXRTZWM6IDMwLCByZXRlbnRpb25QZXJpb2RTZWM6IDEyMDk2MDAsIGRlYWRMZXR0ZXJRdWV1ZSA6IHsgcXVldWU6IGRscSwgbWF4UmVjZWl2ZUNvdW50OiA1MH1cbiAgICB9KTtcblxuICAgIC8vUXVldWVcbiAgICBjb25zdCBqb2JSZXN1bHRzUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdKb2JSZXN1bHRzJywge1xuICAgICAgdmlzaWJpbGl0eVRpbWVvdXRTZWM6IDkwMCwgcmV0ZW50aW9uUGVyaW9kU2VjOiAxMjA5NjAwLCBkZWFkTGV0dGVyUXVldWUgOiB7IHF1ZXVlOiBkbHEsIG1heFJlY2VpdmVDb3VudDogNTB9XG4gICAgfSk7XG4gICAgLy9UcmlnZ2VyXG4gICAgam9iQ29tcGxldGlvblRvcGljLnN1YnNjcmliZVF1ZXVlKGpvYlJlc3VsdHNRdWV1ZSk7XG5cbiAgICAvLyoqKioqKioqKipMYW1iZGEgRnVuY3Rpb25zKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqXG5cbiAgICAvLyBIZWxwZXIgTGF5ZXIgd2l0aCBoZWxwZXIgZnVuY3Rpb25zXG4gICAgY29uc3QgaGVscGVyTGF5ZXIgPSBuZXcgbGFtYmRhLkxheWVyVmVyc2lvbih0aGlzLCAnSGVscGVyTGF5ZXInLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2hlbHBlcicpLFxuICAgICAgY29tcGF0aWJsZVJ1bnRpbWVzOiBbbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzddLFxuICAgICAgbGljZW5zZTogJ0FwYWNoZS0yLjAnLFxuICAgICAgZGVzY3JpcHRpb246ICdIZWxwZXIgbGF5ZXIuJyxcbiAgICB9KTtcblxuICAgIC8vIFRleHRyYWN0b3IgaGVscGVyIGxheWVyXG4gICAgY29uc3QgdGV4dHJhY3RvckxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ1RleHRyYWN0b3InLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3RleHRyYWN0b3InKSxcbiAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW2xhbWJkYS5SdW50aW1lLlB5dGhvbjM3XSxcbiAgICAgIGxpY2Vuc2U6ICdBcGFjaGUtMi4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGV4dHJhY3RvciBsYXllci4nLFxuICAgIH0pO1xuXG4gICAgLy8gVGV4dHJhY3RvciBFbGFzdGljTGF5ZXIgbGF5ZXJcbiAgICAgICAgY29uc3QgZWxhc3RpY0xheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ0VsYXN0aWNMYXllcicsIHtcbiAgICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2VsYXN0aWMnKSxcbiAgICAgICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QeXRob24zN10sXG4gICAgICAgICAgbGljZW5zZTogJ0FwYWNoZS0yLjAnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnRWxhc3RpYyBsYXllci4nLFxuICAgICAgICB9KTtcblxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBTMyBFdmVudCBwcm9jZXNzb3JcbiAgICBjb25zdCBzM1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3MzcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNZTkNfUVVFVUVfVVJMOiBzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgT1VUUFVUX1RBQkxFOiBvdXRwdXRUYWJsZS50YWJsZU5hbWVcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgczNQcm9jZXNzb3IuYWRkTGF5ZXIoZWxhc3RpY0xheWVyKVxuICAgIHMzUHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlclxuICAgIHMzUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTM0V2ZW50U291cmNlKGNvbnRlbnRCdWNrZXQsIHtcbiAgICAgIGV2ZW50czogWyBzMy5FdmVudFR5cGUuT2JqZWN0Q3JlYXRlZCBdXG4gICAgfSkpO1xuICAgIC8vUGVybWlzc2lvbnNcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoczNQcm9jZXNzb3IpXG4gICAgc3luY0pvYnNRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyhzM1Byb2Nlc3NvcilcbiAgICBhc3luY0pvYnNRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyhzM1Byb2Nlc3NvcilcblxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBTMyBCYXRjaCBPcGVyYXRpb25zIEV2ZW50IHByb2Nlc3NvciBcbiAgICBjb25zdCBzM0JhdGNoUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnUzNCYXRjaFByb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zM2JhdGNocHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIERPQ1VNRU5UU19UQUJMRTogZG9jdW1lbnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZVxuICAgICAgfSxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUwLFxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmFkZExheWVyKGVsYXN0aWNMYXllcilcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxuICAgIC8vUGVybWlzc2lvbnNcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoczNCYXRjaFByb2Nlc3NvcilcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmdyYW50SW52b2tlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcbiAgICBzM0JhdGNoT3BlcmF0aW9uc1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoKS5hZGRBbGxSZXNvdXJjZXMoKS5hZGRBY3Rpb25zKFwibGFtYmRhOipcIikpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gRG9jdW1lbnQgcHJvY2Vzc29yIChSb3V0ZXIgdG8gU3luYy9Bc3luYyBQaXBlbGluZSlcbiAgICBjb25zdCBkb2N1bWVudFByb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1Rhc2tQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QeXRob24zNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvZG9jdW1lbnRwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU1lOQ19RVUVVRV9VUkw6IHN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmxcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgZG9jdW1lbnRQcm9jZXNzb3IuYWRkTGF5ZXIoZWxhc3RpY0xheWVyKVxuICAgIGRvY3VtZW50UHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlclxuICAgIGRvY3VtZW50UHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShkb2N1bWVudHNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVHJpbUhvcml6b25cbiAgICB9KSk7XG5cbiAgICAvL1Blcm1pc3Npb25zXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGRvY3VtZW50UHJvY2Vzc29yKVxuICAgIHN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoZG9jdW1lbnRQcm9jZXNzb3IpXG4gICAgYXN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoZG9jdW1lbnRQcm9jZXNzb3IpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gU3luYyBKb2JzIFByb2Nlc3NvciAoUHJvY2VzcyBqb2JzIHVzaW5nIHN5bmMgQVBJcylcbiAgICBjb25zdCBzeW5jUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnU3luY1Byb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zeW5jcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEsXG4gICAgICB0aW1lb3V0OiAyNSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9VVFBVVF9UQUJMRTogb3V0cHV0VGFibGUudGFibGVOYW1lLFxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQVdTX0RBVEFfUEFUSCA6IFwibW9kZWxzXCJcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgc3luY1Byb2Nlc3Nvci5hZGRMYXllcihlbGFzdGljTGF5ZXIpXG4gICAgc3luY1Byb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcbiAgICBzeW5jUHJvY2Vzc29yLmFkZExheWVyKHRleHRyYWN0b3JMYXllcilcbiAgICAvL1RyaWdnZXJcbiAgICBzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTcXNFdmVudFNvdXJjZShzeW5jSm9ic1F1ZXVlLCB7XG4gICAgICBiYXRjaFNpemU6IDFcbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcbiAgICBvdXRwdXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcbiAgICBzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbnMoXCJ0ZXh0cmFjdDoqXCIpKVxuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIEFzeW5jIEpvYiBQcm9jZXNzb3IgKFN0YXJ0IGpvYnMgdXNpbmcgQXN5bmMgQVBJcylcbiAgICBjb25zdCBhc3luY1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0FTeW5jUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2FzeW5jcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUwLFxuICAgICAgdGltZW91dDogNjAsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBTTlNfVE9QSUNfQVJOIDogam9iQ29tcGxldGlvblRvcGljLnRvcGljQXJuLFxuICAgICAgICBTTlNfUk9MRV9BUk4gOiB0ZXh0cmFjdFNlcnZpY2VSb2xlLnJvbGVBcm4sXG4gICAgICAgIEFXU19EQVRBX1BBVEggOiBcIm1vZGVsc1wiXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9hc3luY1Byb2Nlc3Nvci5hZGRFbnZpcm9ubWVudChcIlNOU19UT1BJQ19BUk5cIiwgdGV4dHJhY3RTZXJ2aWNlUm9sZS50b3BpY0FybilcblxuICAgIC8vTGF5ZXJcbiAgICBhc3luY1Byb2Nlc3Nvci5hZGRMYXllcihlbGFzdGljTGF5ZXIpXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2Vyc1xuICAgIC8vIFJ1biBhc3luYyBqb2IgcHJvY2Vzc29yIGV2ZXJ5IDUgbWludXRlc1xuICAgIGNvbnN0IHJ1bGUgPSBuZXcgZXZlbnRzLkV2ZW50UnVsZSh0aGlzLCAnUnVsZScsIHtcbiAgICAgIHNjaGVkdWxlRXhwcmVzc2lvbjogJ3JhdGUoMiBtaW51dGVzKScsXG4gICAgfSk7XG4gICAgcnVsZS5hZGRUYXJnZXQoYXN5bmNQcm9jZXNzb3IpO1xuICAgIC8vUnVuIHdoZW4gYSBqb2IgaXMgc3VjY2Vzc2Z1bGx5IGNvbXBsZXRlXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFNuc0V2ZW50U291cmNlKGpvYkNvbXBsZXRpb25Ub3BpYykpXG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkKGFzeW5jUHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShhc3luY1Byb2Nlc3NvcilcbiAgICBhc3luY0pvYnNRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyhhc3luY1Byb2Nlc3NvcilcbiAgICBhc3luY1Byb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoKS5hZGRSZXNvdXJjZSh0ZXh0cmFjdFNlcnZpY2VSb2xlLnJvbGVBcm4pLmFkZEFjdGlvbignaWFtOlBhc3NSb2xlJykpXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KCkuYWRkQWxsUmVzb3VyY2VzKCkuYWRkQWN0aW9uKFwidGV4dHJhY3Q6KlwiKSlcblxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgICAvLyBBc3luYyBKb2JzIFJlc3VsdHMgUHJvY2Vzc29yXG4gICAgY29uc3Qgam9iUmVzdWx0UHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnSm9iUmVzdWx0UHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2pvYnJlc3VsdHByb2Nlc3NvcicpLFxuICAgICAgaGFuZGxlcjogJ2xhbWJkYV9mdW5jdGlvbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBtZW1vcnlTaXplOiAzMDAwLFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMTAwLFxuICAgICAgdGltZW91dDogOTAwLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgT1VUUFVUX1RBQkxFOiBvdXRwdXRUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERPQ1VNRU5UU19UQUJMRTogZG9jdW1lbnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxuICAgICAgfVxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBqb2JSZXN1bHRQcm9jZXNzb3IuYWRkTGF5ZXIoZWxhc3RpY0xheWVyKVxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcbiAgICBqb2JSZXN1bHRQcm9jZXNzb3IuYWRkTGF5ZXIodGV4dHJhY3RvckxheWVyKVxuICAgIC8vVHJpZ2dlcnNcbiAgICBqb2JSZXN1bHRQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFNxc0V2ZW50U291cmNlKGpvYlJlc3VsdHNRdWV1ZSwge1xuICAgICAgYmF0Y2hTaXplOiAxMFxuICAgIH0pKTtcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgb3V0cHV0VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGpvYlJlc3VsdFByb2Nlc3NvcilcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShqb2JSZXN1bHRQcm9jZXNzb3IpXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbihcInRleHRyYWN0OipcIikpXG4gIH1cbn0iXX0=