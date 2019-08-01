package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/gofrs/uuid"
	"github.com/guregu/dynamo"
	dynamo_helper "github.com/portals-me/api/lib/dynamo"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/portals-me/api/lib/user"
)

var timelineTableName = os.Getenv("timelineTableName")
var userTableName = os.Getenv("userTableName")
var timelineTable dynamo.Table
var userRepository user.Repository

func createNotifiedItemID(itemID string, followerID string) string {
	return followerID + "-" + itemID
}

type TimelineItem struct {
	ID         string `dynamo:"id"`
	Target     string `dynamo:"target"`
	OriginalID string `dynamo:"original_id"`
	UpdatedAt  string `dynamo:"updated_at"`
}

// item should be {id: string, owner: string, updated_at: number}
func createItemsToFollowers(item map[string]*dynamodb.AttributeValue) ([]interface{}, error) {
	ownerID := item["owner"].String()

	followers, err := userRepository.ListFollowers(ownerID)
	if err != nil {
		return nil, err
	}

	var items []interface{}
	for _, follower := range append(followers, ownerID) {
		items = append(items, TimelineItem{
			ID:         uuid.Must(uuid.NewV4()).String(),
			Target:     follower,
			OriginalID: item["id"].String(),
			UpdatedAt:  item["updated_at"].String(),
		})
	}

	return items, nil
}

func createItemsToDelete(item map[string]*dynamodb.AttributeValue) ([]dynamo.Keyed, error) {
	itemID := item["id"].String()

	var timelineItems []TimelineItem
	if err := timelineTable.
		Get("original_id", itemID).
		Index("original_id").
		All(&timelineItems); err != nil {
		return nil, err
	}

	var items []dynamo.Keyed
	for _, timelineItem := range timelineItems {
		items = append(items, dynamo.Keys{timelineItem.ID})
	}

	return items, nil
}

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

			items, err := createItemsToFollowers(item)
			if err != nil {
				return err
			}

			if _, err := timelineTable.Batch().Write().Put(items...).Run(); err != nil {
				return err
			}
		} else if dbEvent.EventName == "REMOVE" {
			item, err := dynamo_helper.AsDynamoDBAttributeValues(dbEvent.Change.Keys)
			if err != nil {
				return err
			}

			items, err := createItemsToDelete(item)
			if err != nil {
				return err
			}

			if _, err := timelineTable.Batch().Write().Delete(items...).Run(); err != nil {
				return err
			}
		} else {
			fmt.Printf("%+v\n", dbEvent)
			panic("Not supported EventName: " + dbEvent.EventName)
		}
	}

	return nil
}

func main() {
	svc := dynamodb.New(session.New())
	userRepository = user.NewRepositoryFromAWS(svc, userTableName)
	timelineTable = dynamo.NewFromIface(svc).Table(timelineTableName)

	lambda.Start(handler)
}
