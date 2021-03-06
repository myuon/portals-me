import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { createLambdaFunction } from "./infrastructure/lambda";
import {
  createLambdaDataSource,
  createDynamoDBDataSource,
  createLambdaResolverFunction,
  createPipelineResolver
} from "./infrastructure/appsync";
import { createLambdaSubscription } from "./infrastructure/subscription";
import { hookDynamoDB } from "./infrastructure/dynamodb_sns";

const config = {
  service: new pulumi.Config().name,
  stage: pulumi.getStack()
};

const parameter = {
  jwtPrivate: aws.ssm
    .getParameter({
      name: config.stage.startsWith("test")
        ? `${config.service}-stg-jwt-private`
        : `${config.service}-${config.stage}-jwt-private`,
      withDecryption: true
    })
    .then(result => result.value),
  accountEventTopic: `arn:aws:sns:ap-northeast-1:941528793676:portals-me-account-${
    config.stage.startsWith("test") ? "stg" : config.stage
  }-account-table-event-topic`
};

const lambdaRole = (() => {
  const role = new aws.iam.Role("lambda-role", {
    assumeRolePolicy: aws.iam
      .getPolicyDocument({
        statements: [
          {
            actions: ["sts:AssumeRole"],
            principals: [
              {
                identifiers: ["lambda.amazonaws.com"],
                type: "Service"
              }
            ]
          }
        ]
      })
      .then(result => result.json)
  });
  new aws.iam.RolePolicyAttachment("lambda-role-lambdafull", {
    role: role,
    policyArn: aws.iam.AWSLambdaFullAccess
  });

  return role;
})();

const authorizer = createLambdaFunction("authorizer", {
  filepath: "authorizer",
  handlerName: `${config.service}-${config.stage}-authorizer`,
  role: lambdaRole,
  lambdaOptions: {
    environment: {
      variables: {
        jwtPrivate: parameter.jwtPrivate
      }
    }
  }
});

const postTable = new aws.dynamodb.Table("post", {
  billingMode: "PAY_PER_REQUEST",
  name: `${config.service}-${config.stage}-post`,
  attributes: [
    {
      name: "id",
      type: "S"
    },
    {
      name: "sort",
      type: "S"
    },
    {
      name: "updated_at",
      type: "N"
    },
    {
      name: "owner",
      type: "S"
    }
  ],
  hashKey: "id",
  rangeKey: "sort",
  globalSecondaryIndexes: [
    {
      name: "owner",
      hashKey: "owner",
      rangeKey: "updated_at",
      projectionType: "ALL"
    }
  ],
  streamEnabled: true,
  streamViewType: "NEW_IMAGE"
});

const accountReplicaTable = new aws.dynamodb.Table("account-replica", {
  billingMode: "PAY_PER_REQUEST",
  name: `${config.service}-${config.stage}-account-replica`,
  attributes: [
    {
      name: "id",
      type: "S"
    },
    {
      name: "sort",
      type: "S"
    },
    {
      name: "name",
      type: "S"
    }
  ],
  hashKey: "id",
  rangeKey: "sort",
  globalSecondaryIndexes: [
    {
      name: "name",
      hashKey: "name",
      projectionType: "ALL"
    }
  ]
});

const accountEventSubscription = createLambdaSubscription("put-account-table", {
  function: createLambdaFunction("put-account-table", {
    filepath: "put-account-table",
    handlerName: `${config.service}-${config.stage}-put-account-table`,
    role: lambdaRole,
    lambdaOptions: {
      environment: {
        variables: {
          accountTableName: accountReplicaTable.name
        }
      }
    }
  }),
  snsTopicArn: parameter.accountEventTopic as any
});

const graphqlApi = new aws.appsync.GraphQLApi("graphql-api", {
  name: `${config.service}-${config.stage}-api`,
  authenticationType: "API_KEY",
  schema: fs.readFileSync("./schema.graphql").toString(),
  logConfig: {
    cloudwatchLogsRoleArn:
      "arn:aws:iam::941528793676:role/AppSyncToCWLServiceRole",
    fieldLogLevel: "ALL"
  }
});

// API Key expires in one year
const graphqlApiKey = new aws.appsync.ApiKey(
  "graphql-api-key",
  {
    apiId: graphqlApi.id,
    expires: new Date(
      new Date().getTime() + 1000 * 60 * 60 * 24 * 365
    ).toISOString()
  },
  {
    dependsOn: [graphqlApi]
  }
);

const authorizerDS = createLambdaDataSource("authorizer", {
  api: graphqlApi,
  function: authorizer,
  dataSourceName: "authorizer"
});
const postDS = createDynamoDBDataSource("post", {
  api: graphqlApi,
  table: postTable,
  dataSourceName: "post"
});
const accountDS = createDynamoDBDataSource("account", {
  api: graphqlApi,
  table: accountReplicaTable,
  dataSourceName: "account"
});

const authorizerFunctionResolver = new aws.appsync.Function(
  "authorizer-function",
  {
    apiId: graphqlApi.id,
    dataSource: authorizerDS.name,
    requestMappingTemplate: fs
      .readFileSync("./vtl/AuthorizerRequest.vtl")
      .toString(),
    responseMappingTemplate: fs
      .readFileSync("./vtl/AuthorizerResponse.vtl")
      .toString(),
    name: "authorizer"
  }
);

const replaceOwner = createLambdaFunction("replace-owner", {
  filepath: "replace-owner",
  handlerName: `${config.service}-${config.stage}-replace-owner`,
  role: lambdaRole,
  lambdaOptions: {
    environment: {
      variables: {
        accountTableName: accountReplicaTable.name
      }
    }
  }
});

const replaceOwnerDS = createLambdaDataSource("replace-owner", {
  api: graphqlApi,
  function: replaceOwner,
  dataSourceName: "replaceOwner"
});

const replaceOwnerFunction = new aws.appsync.Function(
  "replace-owner-function",
  {
    apiId: graphqlApi.id,
    dataSource: replaceOwnerDS.name,
    requestMappingTemplate: fs
      .readFileSync("./vtl/ReplaceOwnerRequest.vtl")
      .toString(),
    responseMappingTemplate: fs
      .readFileSync("./vtl/ReplaceOwnerResponse.vtl")
      .toString(),
    name: "replaceOwner"
  }
);

const getUserByName = new aws.appsync.Resolver("getUserByName", {
  apiId: graphqlApi.id,
  dataSource: accountDS.name,
  field: "getUserByName",
  type: "Query",
  requestTemplate: fs.readFileSync("./vtl/user/GetUserByName.vtl").toString(),
  responseTemplate: fs
    .readFileSync("./vtl/user/GetUserByNameResponse.vtl")
    .toString()
});

const getUserSocial = createPipelineResolver("get-user-social", {
  api: graphqlApi,
  field: "getUserMoreByName",
  type: "Query",
  pipeline: [
    authorizerFunctionResolver,
    createLambdaResolverFunction("get-user-social", {
      lambda: {
        filepath: "get-user-social",
        handlerName: `${config.service}-${config.stage}-get-user-social`,
        role: lambdaRole,
        lambdaOptions: {
          environment: {
            variables: {
              accountTableName: accountReplicaTable.name
            }
          }
        }
      },
      api: graphqlApi
    })
  ]
});

const followUser = createPipelineResolver("follow-user", {
  api: graphqlApi,
  field: "followUser",
  type: "Mutation",
  pipeline: [
    authorizerFunctionResolver,
    new aws.appsync.Function("followUser", {
      apiId: graphqlApi.id,
      dataSource: accountDS.name,
      requestMappingTemplate: fs
        .readFileSync("./vtl/user/FollowUser.vtl")
        .toString(),
      responseMappingTemplate: `
        #if($context.error)
          $util.error($context.error.type, $context.error.message)
        #end
        $utils.toJson($util.map.copyAndRetainAllKeys($context.result, [ "id", "follow" ]))`,
      name: "followUser"
    }),
    createLambdaResolverFunction("count-up-followers", {
      lambda: {
        filepath: "count-up-followers",
        handlerName: `${config.service}-${config.stage}-count-up-followers`,
        role: lambdaRole,
        lambdaOptions: {
          environment: {
            variables: {
              accountTableName: accountReplicaTable.name
            }
          }
        }
      },
      api: graphqlApi
    })
  ]
});

const unfollowUser = createPipelineResolver("unfollow-user", {
  api: graphqlApi,
  field: "unfollowUser",
  type: "Mutation",
  pipeline: [
    authorizerFunctionResolver,
    new aws.appsync.Function("unfollowUser", {
      apiId: graphqlApi.id,
      dataSource: accountDS.name,
      requestMappingTemplate: fs
        .readFileSync("./vtl/user/UnfollowUser.vtl")
        .toString(),
      responseMappingTemplate: `
        #if($context.error)
          $util.error($context.error.type, $context.error.message)
        #end
        
        $utils.toJson($util.map.copyAndRetainAllKeys($context.result, [ "id", "follow" ]))`,
      name: "unfollowUser"
    })
  ]
});

const listPostSummary = (() => {
  const listPostSummaryFunction = new aws.appsync.Function("listPostSummary", {
    apiId: graphqlApi.id,
    dataSource: postDS.name,
    requestMappingTemplate: fs
      .readFileSync("./vtl/post/ListPostSummary.vtl")
      .toString(),
    responseMappingTemplate: fs
      .readFileSync("./vtl/post/PostSummaryItems.vtl")
      .toString(),
    name: "listPostSummary"
  });

  return new aws.appsync.Resolver(
    "listPostSummary",
    {
      apiId: graphqlApi.id,
      field: "listPostSummary",
      type: "Query",
      requestTemplate: fs.readFileSync("./vtl/ContextRequest.vtl").toString(),
      responseTemplate: fs.readFileSync("./vtl/PrevResult.vtl").toString(),
      kind: "PIPELINE",
      pipelineConfig: {
        functions: [
          authorizerFunctionResolver.functionId,
          listPostSummaryFunction.functionId,
          replaceOwnerFunction.functionId
        ]
      }
    },
    {
      dependsOn: [
        authorizerFunctionResolver,
        listPostSummaryFunction,
        replaceOwnerFunction
      ]
    }
  );
})();

const addSharePost = (() => {
  const addSharePostFunction = new aws.appsync.Function("addSharePost", {
    apiId: graphqlApi.id,
    dataSource: postDS.name,
    requestMappingTemplate: fs
      .readFileSync("./vtl/post/AddSharePost.vtl")
      .toString(),
    responseMappingTemplate: fs
      .readFileSync("./vtl/post/PostSummary.vtl")
      .toString()
  });

  return new aws.appsync.Resolver(
    "addSharePost",
    {
      apiId: graphqlApi.id,
      field: "addSharePost",
      type: "Mutation",
      requestTemplate: fs.readFileSync("./vtl/ContextRequest.vtl").toString(),
      responseTemplate: fs.readFileSync("./vtl/PrevResult.vtl").toString(),
      kind: "PIPELINE",
      pipelineConfig: {
        functions: [
          authorizerFunctionResolver.functionId,
          addSharePostFunction.functionId
        ]
      }
    },
    {
      dependsOn: [authorizerFunctionResolver, addSharePostFunction]
    }
  );
})();

const addImagePost = (() => {
  const addImagePostFunction = new aws.appsync.Function("addImagePost", {
    apiId: graphqlApi.id,
    dataSource: postDS.name,
    requestMappingTemplate: fs
      .readFileSync("./vtl/post/AddImagePost.vtl")
      .toString(),
    responseMappingTemplate: fs
      .readFileSync("./vtl/post/PostSummary.vtl")
      .toString(),
    name: "addImagePost"
  });

  return new aws.appsync.Resolver(
    "addImagePost",
    {
      apiId: graphqlApi.id,
      field: "addImagePost",
      type: "Mutation",
      requestTemplate: fs.readFileSync("./vtl/ContextRequest.vtl").toString(),
      responseTemplate: fs.readFileSync("./vtl/PrevResult.vtl").toString(),
      kind: "PIPELINE",
      pipelineConfig: {
        functions: [
          authorizerFunctionResolver.functionId,
          addImagePostFunction.functionId
        ]
      }
    },
    {
      dependsOn: [authorizerFunctionResolver, addImagePostFunction]
    }
  );
})();

const addArticlePost = createPipelineResolver("add-article-post", {
  api: graphqlApi,
  field: "addArticlePost",
  type: "Mutation",
  pipeline: [
    authorizerFunctionResolver,
    new aws.appsync.Function(
      "addArticlePost",
      {
        apiId: graphqlApi.id,
        dataSource: postDS.name,
        requestMappingTemplate: `{
  "version": "2017-02-28",
  "operation": "PutItem",
  "key": {
    "id": { "S": "$\{util.autoId()\}" },
    "sort": { "S": "summary" }
  },

  #set ( $account = $context.prev.result )

  #set ( $args = $util.dynamodb.toMapValues($context.arguments) )
  #set ( $args.created_at = $util.dynamodb.toNumber($util.time.nowEpochSeconds()) )
  #set ( $args.updated_at = $util.dynamodb.toNumber($util.time.nowEpochSeconds()) )
  #set ( $args.owner = $util.dynamodb.toString($account.id) )
  #set ( $args.entity_type = $util.dynamodb.toString("Article") )

  "attributeValues": $util.toJson($args)
}`,
        responseMappingTemplate: fs
          .readFileSync("./vtl/post/PostSummary.vtl")
          .toString(),
        name: "addArticlePost"
      },
      {
        dependsOn: [graphqlApi]
      }
    )
  ]
});

const userStorage = new aws.s3.Bucket("user-storage", {
  bucketPrefix: `${config.service}-${config.stage}-user-storage`.substr(0, 35),
  corsRules: [
    {
      allowedHeaders: ["*"],
      allowedMethods: ["GET", "PUT", "POST", "DELETE"],
      allowedOrigins: ["*"]
    }
  ]
});
new aws.s3.BucketPolicy("user-storage-policy", {
  bucket: userStorage.bucket,
  policy: pulumi.interpolate`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::${userStorage.bucket}/*"]
    }
  ]
}`
});

const generateUploadURL = (() => {
  const generateUploadURLDataSource = createLambdaDataSource(
    "generate-upload-url-ds",
    {
      api: graphqlApi,
      function: createLambdaFunction("generate-upload-url", {
        filepath: "generate-upload-url",
        handlerName: `${config.service}-${config.stage}-generate-upload-url`,
        role: lambdaRole,
        lambdaOptions: {
          environment: {
            variables: {
              storageBucket: userStorage.bucket
            }
          }
        }
      }),
      dataSourceName: "generateUploadURL"
    }
  );

  const generateUploadURLFunction = new aws.appsync.Function(
    "generateUploadURL",
    {
      apiId: graphqlApi.id,
      dataSource: generateUploadURLDataSource.name,
      requestMappingTemplate: fs
        .readFileSync("./vtl/AuthorizerRequest.vtl")
        .toString(),
      responseMappingTemplate: fs
        .readFileSync("./vtl/AuthorizerResponse.vtl")
        .toString(),
      name: "generateUploadURL"
    }
  );

  return new aws.appsync.Resolver(
    "generateUploadURL",
    {
      apiId: graphqlApi.id,
      field: "generateUploadURL",
      type: "Mutation",
      requestTemplate: fs.readFileSync("./vtl/ContextRequest.vtl").toString(),
      responseTemplate: fs.readFileSync("./vtl/PrevResult.vtl").toString(),
      kind: "PIPELINE",
      pipelineConfig: {
        functions: [
          authorizerFunctionResolver.functionId,
          generateUploadURLFunction.functionId
        ]
      }
    },
    {
      dependsOn: [authorizerFunctionResolver, generateUploadURLFunction]
    }
  );
})();

const postTableHook = hookDynamoDB("post-table-sync", {
  topic: {
    name: `${config.service}-${config.stage}-post-table-subscription`
  },
  lambda: topicArn => ({
    filepath: "hook-post-table",
    handlerName: `${config.service}-${config.stage}-hook-post-table`,
    role: lambdaRole,
    lambdaOptions: {
      environment: {
        variables: {
          timestamp: new Date().toLocaleString(),
          topicArn
        }
      }
    }
  }),
  table: postTable
});

// Timeline
const timelineTable = new aws.dynamodb.Table("timeline", {
  billingMode: "PAY_PER_REQUEST",
  name: `${config.service}-${config.stage}-timeline`,
  attributes: [
    {
      name: "id",
      type: "S"
    },
    {
      name: "updated_at",
      type: "N"
    },
    {
      name: "target",
      type: "S"
    },
    {
      name: "original_id",
      type: "S"
    }
  ],
  hashKey: "id",
  globalSecondaryIndexes: [
    {
      name: "target",
      hashKey: "target",
      rangeKey: "updated_at",
      projectionType: "ALL"
    },
    {
      name: "original_id",
      hashKey: "original_id",
      projectionType: "KEYS_ONLY"
    }
  ]
});

const putTimelineItems = createLambdaSubscription("put-timeline-items", {
  function: createLambdaFunction(
    "put-timeline-items",
    {
      filepath: "put-timeline-items",
      handlerName: `${config.service}-${config.stage}-put-timeline-items`,
      role: lambdaRole,
      lambdaOptions: {
        environment: {
          variables: {
            timelineTableName: timelineTable.name,
            userTableName: accountReplicaTable.name
          }
        }
      }
    },
    {
      dependsOn: [postTableHook.topic]
    }
  ),
  snsTopicArn: postTableHook.topic.arn
});

const fetchItems = createLambdaFunction("fetch-items", {
  filepath: "fetch-items",
  handlerName: `${config.service}-${config.stage}-fetch-items`,
  role: lambdaRole,
  lambdaOptions: {
    environment: {
      variables: {
        postTableName: postTable.name,
        timelineTableName: timelineTable.name,
        accountTableName: accountReplicaTable.name
      }
    }
  }
});

const fetchItemsDS = createLambdaDataSource("fetch-items", {
  api: graphqlApi,
  function: fetchItems,
  dataSourceName: "fetchItems"
});

const fetchTimeline = createPipelineResolver("fetch-timeline", {
  api: graphqlApi,
  field: "fetchTimeline",
  type: "Query",
  pipeline: [
    authorizerFunctionResolver,
    new aws.appsync.Function("fetch-items-function", {
      apiId: graphqlApi.id,
      dataSource: fetchItemsDS.name,
      requestMappingTemplate: `{
  "version": "2017-02-28",
  "operation": "Invoke",
  "payload": $utils.toJson($context.prev.result)
}`,
      responseMappingTemplate: `#if($context.error)
  $util.error($context.error.type, $context.error.message)
#end

#set ( $resultItems = [] )

#foreach ( $item in $context.result )
  #set ( $result = $util.map.copyAndRemoveAllKeys($item, [ "sort" ]) )

  ## For union type resolution
  $util.qr( $result.entity.put("__typename", $result.entity_type) )

  $util.qr( $resultItems.add( $result ) )
#end

$utils.toJson($resultItems)`,
      name: "fetchItems"
    })
  ]
});

export const output = {
  appsync: {
    url: graphqlApi.uris["GRAPHQL"],
    apiKey: graphqlApiKey.key
  },
  userStorageBucket: userStorage.bucket,
  postTableName: postTable.name,
  accountReplicaTableName: accountReplicaTable.name,
  timelineTableName: timelineTable.name
};
