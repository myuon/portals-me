package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	dynamo_helper "github.com/portals-me/api/lib/dynamo"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

var svc *dynamodb.DynamoDB
var accountTable = os.Getenv("accountTableName")

func handler(ctx context.Context, event events.SNSEvent) error {
	for _, record := range event.Records {
		message := record.SNS.Message

		var dbEvent events.DynamoDBEventRecord
		if err := json.Unmarshal([]byte(message), &dbEvent); err != nil {
			return err
		}

		if dbEvent.EventName == "MODIFY" || dbEvent.EventName == "INSERT" {
			item, err := dynamo_helper.AsDynamoDBAttributeValues(dbEvent.Change.NewImage)
			if err != nil {
				return err
			}

			if _, err := svc.PutItem(&dynamodb.PutItemInput{
				TableName: aws.String(accountTable),
				Item:      item,
			}); err != nil {
				return err
			}

			// Skip error check
			svc.PutItem(&dynamodb.PutItemInput{
				TableName: aws.String(accountTable),
				Item: map[string]*dynamodb.AttributeValue{
					"id":         item["id"],
					"sort":       &dynamodb.AttributeValue{S: aws.String("social")},
					"followers":  &dynamodb.AttributeValue{N: aws.String("0")},
					"followings": &dynamodb.AttributeValue{N: aws.String("0")},
				},
				ConditionExpression: aws.String("attribute_not_exists(id)"),
			})
		} else if dbEvent.EventName == "REMOVE" {
			item, err := dynamo_helper.AsDynamoDBAttributeValues(dbEvent.Change.Keys)
			if err != nil {
				return err
			}

			if _, err := svc.DeleteItem(&dynamodb.DeleteItemInput{
				TableName: aws.String(accountTable),
				Key:       item,
			}); err != nil {
				return err
			}

			// Skip error check
			svc.DeleteItem(&dynamodb.DeleteItemInput{
				TableName: aws.String(accountTable),
				Key: map[string]*dynamodb.AttributeValue{
					"id":   item["id"],
					"sort": &dynamodb.AttributeValue{S: aws.String("social")},
				},
				ConditionExpression: aws.String("attribute_exists(id)"),
			})
		} else {
			fmt.Printf("%+v\n", dbEvent)
			panic("Not supported EventName: " + dbEvent.EventName)
		}
	}

	return nil
}

func main() {
	svc = dynamodb.New(session.New())

	lambda.Start(handler)
}
