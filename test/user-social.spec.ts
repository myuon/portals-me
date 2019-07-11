import AWS from "aws-sdk";
import uuid from "uuid/v4";
import axios from "axios";
import { createUser, deleteUser } from "./user";

AWS.config.update({
  region: "ap-northeast-1"
});

const Dynamo = new AWS.DynamoDB.DocumentClient();
const S3 = new AWS.S3();

const apiEnv: {
  appsync: {
    url: string;
    apiKey: string;
  };
  userStorageBucket: string;
  postTableName: string;
  accountReplicaTableName: string;
} = JSON.parse(process.env.API_ENV);

const accountEnv: {
  restApi: string;
  tableName: string;
} = JSON.parse(process.env.ACCOUNT_ENV);

const adminUser = {
  id: uuid(),
  name: `admin_${uuid().replace(/\-/g, "_")}`,
  password: uuid(),
  display_name: "Admin",
  picture: "pic"
};

let adminUserJWT;

beforeAll(async () => {
  const userRecord = await createUser(accountEnv.tableName, adminUser);
  await Dynamo.put({
    Item: userRecord,
    TableName: apiEnv.accountReplicaTableName
  }).promise();

  adminUserJWT = (await axios.post(`${accountEnv.restApi}/signin`, {
    auth_type: "password",
    data: {
      user_name: adminUser.name,
      password: adminUser.password
    }
  })).data;
});

afterAll(async () => {
  await deleteUser(accountEnv.tableName, adminUser);
  await Dynamo.delete({
    Key: {
      id: adminUser.id,
      sort: "detail"
    },
    TableName: apiEnv.accountReplicaTableName
  });
});

describe("User", () => {
  it("should show UserMore information", async () => {
    const result = await axios.post(
      apiEnv.appsync.url,
      {
        query: `query Q {
          getUserMoreByName(name: "${adminUser.name}") {
            id
            name
            is_following
            followings
            followers
          }
        }`
      },
      {
        headers: {
          Authorization: `Bearer ${adminUserJWT}`,
          "x-api-key": apiEnv.appsync.apiKey
        }
      }
    );

    expect(result.data.data.getUserMoreByName).toBeTruthy();

    const userMore = result.data.data.getUserMoreByName;

    expect(userMore.id).toBeTruthy();
    expect(userMore.is_following).toBe(false);
    expect(userMore.followings).toBe(0);
    expect(userMore.followers).toBe(0);
  });
});
