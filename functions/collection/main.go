package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/dynamodbiface"
	uuid "github.com/satori/go.uuid"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/external"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/dynamodbattribute"

	"github.com/aws/aws-lambda-go/events"

	"github.com/aws/aws-lambda-go/lambda"
)

type CollectionDBO struct {
	ID             string            `json:"id"`
	CommentMembers []string          `json:"comment_members"`
	CommentCount   int               `json:"comment_count"`
	Media          []string          `json:"media"`
	Cover          map[string]string `json:"cover"`
	Owner          string            `json:"sort_value"`
	Title          string            `json:"title"`
	CreatedAt      int64             `json:"created_at"`
	Sort           string            `json:"sort"`
	Description    string            `json:"description"`
}

type Collection struct {
	ID             string            `json:"id"`
	CommentMembers []string          `json:"comment_members"`
	CommentCount   int               `json:"comment_count"`
	Media          []string          `json:"media"`
	Cover          map[string]string `json:"cover"`
	Owner          string            `json:"owner"`
	Title          string            `json:"title"`
	CreatedAt      int64             `json:"created_at"`
	Description    string            `json:"description"`
}

func (collection Collection) toDBO() CollectionDBO {
	return CollectionDBO{
		ID:             "collection##" + collection.ID,
		CommentMembers: collection.CommentMembers,
		CommentCount:   collection.CommentCount,
		Media:          collection.Media,
		Cover:          collection.Cover,
		Owner:          collection.Owner,
		Title:          collection.Title,
		CreatedAt:      collection.CreatedAt,
		Description:    collection.Description,
		Sort:           "collection##sort",
	}
}

func (collection CollectionDBO) fromDBO() Collection {
	return Collection{
		ID:             strings.Split(collection.ID, "collection##")[1],
		CommentMembers: collection.CommentMembers,
		CommentCount:   collection.CommentCount,
		Media:          collection.Media,
		Cover:          collection.Cover,
		Owner:          collection.Owner,
		Title:          collection.Title,
		CreatedAt:      collection.CreatedAt,
		Description:    collection.Description,
	}
}

func parseCollections(attrs []map[string]dynamodb.AttributeValue) []Collection {
	var collectionsDBO []CollectionDBO
	dynamodbattribute.UnmarshalListOfMaps(attrs, &collectionsDBO)

	var collections []Collection
	for _, v := range collectionsDBO {
		collections = append(collections, v.fromDBO())
	}

	return collections
}

func parseCollection(attr map[string]dynamodb.AttributeValue) Collection {
	var collectionDBO CollectionDBO
	dynamodbattribute.UnmarshalMap(attr, &collectionDBO)

	return collectionDBO.fromDBO()
}

func dumpCollection(collection Collection) (map[string]dynamodb.AttributeValue, error) {
	return dynamodbattribute.MarshalMap(collection.toDBO())
}

func doList(
	user map[string]interface{},
	ddb dynamodbiface.DynamoDBAPI,
) ([]Collection, error) {
	result, err := ddb.QueryRequest(&dynamodb.QueryInput{
		TableName:              aws.String(os.Getenv("EntityTable")),
		IndexName:              aws.String(os.Getenv("SortIndex")),
		KeyConditionExpression: aws.String("sort = :sort and sort_value = :sort_value"),
		ExpressionAttributeValues: map[string]dynamodb.AttributeValue{
			":sort":       {S: aws.String("collection##detail")},
			":sort_value": {S: aws.String(user["id"].(string))},
		},
	}).Send()

	if err != nil {
		return nil, err
	}

	return parseCollections(result.Items), nil
}

func doGet(
	collectionID string,
	user map[string]interface{},
	ddb dynamodbiface.DynamoDBAPI,
) (Collection, error) {
	result, err := ddb.GetItemRequest(&dynamodb.GetItemInput{
		TableName: aws.String(os.Getenv("EntityTable")),
		Key: map[string]dynamodb.AttributeValue{
			"id":   {S: aws.String("collection##" + collectionID)},
			"sort": {S: aws.String("collection##detail")},
		},
	}).Send()
	if err != nil {
		return Collection{}, err
	}

	collection := parseCollection(result.Item)

	result, err = ddb.GetItemRequest(&dynamodb.GetItemInput{
		TableName: aws.String(os.Getenv("EntityTable")),
		Key: map[string]dynamodb.AttributeValue{
			"id":   {S: aws.String(collection.Owner)},
			"sort": {S: aws.String("user##detail")},
		},
	}).Send()

	// First-aid
	collection.Owner = *result.Item["sort_value"].S

	return collection, nil
}

type CreateInput struct {
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Cover       map[string]string `json:"cover"`
}

func doCreate(
	createInput CreateInput,
	user map[string]interface{},
	ddb dynamodbiface.DynamoDBAPI,
) (string, error) {
	collectionID := uuid.Must(uuid.NewV4()).String()

	item, err := dumpCollection(Collection{
		ID:             collectionID,
		Owner:          user["id"].(string),
		Title:          createInput.Title,
		Description:    createInput.Description,
		Cover:          createInput.Cover,
		Media:          []string{},
		CommentMembers: []string{user["id"].(string)},
		CommentCount:   0,
		CreatedAt:      time.Now().Unix(),
	})
	if err != nil {
		return "", err
	}

	if _, err = ddb.PutItemRequest(&dynamodb.PutItemInput{
		TableName: aws.String(os.Getenv("EntityTable")),
		Item:      item,
	}).Send(); err != nil {
		return "", err
	}

	return collectionID, nil
}

func doDelete(
	collectionID string,
	user map[string]interface{},
	ddb dynamodbiface.DynamoDBAPI,
) error {
	result, err := ddb.QueryRequest(&dynamodb.QueryInput{
		TableName:              aws.String(os.Getenv("EntityTable")),
		KeyConditionExpression: aws.String("id = :id and owned_by = :user_id"),
		ExpressionAttributeValues: map[string]dynamodb.AttributeValue{
			":id":      {S: aws.String("collection##" + collectionID)},
			":user_id": {S: aws.String(user["id"].(string))},
		},
		ProjectionExpression: aws.String("sort"),
	}).Send()

	if err != nil {
		return err
	}

	writeRequest := []dynamodb.WriteRequest{}
	for _, item := range result.Items {
		writeRequest = append(writeRequest, dynamodb.WriteRequest{
			DeleteRequest: &dynamodb.DeleteRequest{
				Key: map[string]dynamodb.AttributeValue{
					"id":   {S: aws.String("collection##" + collectionID)},
					"sort": item["sort"],
				},
			},
		})
	}

	requestItems := map[string][]dynamodb.WriteRequest{}
	requestItems[os.Getenv("EntityTable")] = writeRequest
	_, err = ddb.BatchWriteItemRequest(&dynamodb.BatchWriteItemInput{
		RequestItems: requestItems,
	}).Send()

	if err != nil {
		return err
	}

	return nil
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	user := event.RequestContext.Authorizer

	cfg, err := external.LoadDefaultAWSConfig()
	if err != nil {
		return events.APIGatewayProxyResponse{}, err
	}

	ddb := dynamodb.New(cfg)

	if event.HTTPMethod == "GET" {
		if event.PathParameters == nil {
			collections, err := doList(user, ddb)
			if err != nil {
				return events.APIGatewayProxyResponse{}, err
			}

			out, _ := json.Marshal(collections)
			return events.APIGatewayProxyResponse{
				Body:       string(out),
				Headers:    map[string]string{"Access-Control-Allow-Origin": "*"},
				StatusCode: 200,
			}, nil
		} else {
			collection, err := doGet(event.PathParameters["collectionId"], user, ddb)
			if err != nil {
				return events.APIGatewayProxyResponse{}, err
			}

			out, _ := json.Marshal(collection)
			return events.APIGatewayProxyResponse{
				Body:       string(out),
				Headers:    map[string]string{"Access-Control-Allow-Origin": "*"},
				StatusCode: 200,
			}, nil
		}
	} else if event.HTTPMethod == "POST" {
		var createInput CreateInput
		json.Unmarshal([]byte(event.Body), &createInput)

		collectionID, err := doCreate(createInput, user, ddb)
		if err != nil {
			return events.APIGatewayProxyResponse{}, err
		}

		return events.APIGatewayProxyResponse{
			Headers: map[string]string{
				"Access-Control-Allow-Origin": "*",
				"Location":                    "/collections/" + collectionID,
			},
			StatusCode: 201,
		}, nil
	} else if event.HTTPMethod == "DELETE" {
		err := doDelete(event.PathParameters["collectionId"], user, ddb)
		if err != nil {
			return events.APIGatewayProxyResponse{}, err
		}

		return events.APIGatewayProxyResponse{
			Headers:    map[string]string{"Access-Control-Allow-Origin": "*"},
			StatusCode: 204,
		}, nil
	}

	return events.APIGatewayProxyResponse{
		Body:       fmt.Sprintf("%+v", event.PathParameters),
		Headers:    map[string]string{"Access-Control-Allow-Origin": "*"},
		StatusCode: 400,
	}, nil
}

func main() {
	lambda.Start(handler)
}
