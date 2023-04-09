import path from 'path';

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import * as lambda from '../../../lambda';

export interface AlarmNotificationArgs {
    region: pulumi.Input<string>;
    accountId: pulumi.Input<string>;
    chatWebhook: pulumi.Input<string>;
    kmsKey: aws.kms.Key;
    kmsAlias: aws.kms.Alias;
    logGroupRetentionDays?: pulumi.Input<number>;
    tags?: Record<string, string>;
}

export class AlarmNotification extends pulumi.ComponentResource {
    readonly role: aws.iam.Role;

    readonly lambdaFunction: aws.lambda.Function;

    readonly logGroup: aws.cloudwatch.LogGroup;

    readonly snsTopic: aws.sns.Topic;

    readonly snsTopicEventSubscription: aws.sns.TopicEventSubscription;

    constructor(name: string, args: AlarmNotificationArgs, opts?: pulumi.ResourceOptions) {
        super('contrib:components:AlarmNotification', name, {}, opts);

        const { region, accountId, chatWebhook, kmsKey, kmsAlias, tags } = args;
        const logGroupRetentionDays = args.logGroupRetentionDays || 14;

        const role = this.createRole(name, region, accountId, tags);

        const chatWebhookCiphertext = this.encrypt(name, kmsKey, chatWebhook);

        const lambdaFunction = this.createLambdaFunction(
            name,
            region,
            role,
            chatWebhookCiphertext,
            kmsAlias,
            tags
        );

        const logGroup = this.createLogGroup(name, lambdaFunction, logGroupRetentionDays, tags);

        const snsTopic = this.createSnsTopic(name, tags);

        const snsTopicEventSubscription = AlarmNotification.subscribeLambdaFunctionOnSnsTopic(
            name,
            lambdaFunction,
            snsTopic
        );

        this.role = role;
        this.lambdaFunction = lambdaFunction;
        this.logGroup = logGroup;
        this.snsTopic = snsTopic;
        this.snsTopicEventSubscription = snsTopicEventSubscription;
    }

    private createRole(
        name: string,
        region: pulumi.Input<string>,
        accountId: pulumi.Input<string>,
        tags?: Record<string, string>
    ): aws.iam.Role {
        return lambda.createLambdaRole(
            name,
            {
                name, // It was necessary because of kms key policy
                region,
                accountId,
                tags,
            },
            { parent: this }
        ).role;
    }

    private encrypt(
        name: string,
        kmsKey: aws.kms.Key,
        content: pulumi.Input<string>
    ): aws.kms.Ciphertext {
        return new aws.kms.Ciphertext(
            name,
            {
                keyId: kmsKey.keyId,
                plaintext: content,
            },
            { parent: this }
        );
    }

    private createLambdaFunction(
        name: string,
        region: pulumi.Input<string>,
        role: aws.iam.Role,
        chatWebhookCiphertext: aws.kms.Ciphertext,
        kmsAlias: aws.kms.Alias,
        tags?: Record<string, string>
    ): aws.lambda.Function {
        const directory = path.join(__dirname, '/function');
        const handler = 'index.handler';

        const assetArchive = new pulumi.asset.FileArchive(directory);

        return new aws.lambda.Function(
            name,
            {
                runtime: 'nodejs18.x',
                timeout: 60,
                role: role.arn,
                code: assetArchive,
                handler,
                environment: {
                    variables: {
                        CHAT_WEBHOOK: chatWebhookCiphertext.ciphertextBlob,
                        KMS_KEY_ID: kmsAlias.arn,
                        KMS_REGION: region,
                    },
                },
                tags,
            },
            { parent: this }
        );
    }

    private createLogGroup(
        name: string,
        lambdaFunction: aws.lambda.CallbackFunction<aws.sns.TopicEvent, unknown>,
        logGroupRetentionDays: pulumi.Input<number>,
        tags?: Record<string, string>
    ): aws.cloudwatch.LogGroup {
        return new aws.cloudwatch.LogGroup(
            `/aws/lambda/${name}`,
            {
                name: pulumi.interpolate`/aws/lambda/${lambdaFunction.name}`,
                retentionInDays: logGroupRetentionDays,
                tags,
            },
            { parent: this }
        );
    }

    private createSnsTopic(name: string, tags?: Record<string, string>): aws.sns.Topic {
        return new aws.sns.Topic(name, { tags }, { parent: this });
    }

    private static subscribeLambdaFunctionOnSnsTopic(
        name: string,
        lambdaFunction: aws.lambda.CallbackFunction<aws.sns.TopicEvent, unknown>,
        snsTopic: aws.sns.Topic
    ): aws.sns.TopicEventSubscription {
        return snsTopic.onEvent(name, lambdaFunction);
    }
}
