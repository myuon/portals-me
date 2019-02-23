variable "entity-stream_arn" {}
variable "stream-count" {
  default = 1
}


resource "aws_dynamodb_table" "entities" {
  name = "${var.service}-${var.stage}-entities"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  range_key = "sort"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "sort"
    type = "S"
  }

  attribute {
    name = "sort_value"
    type = "S"
  }

  global_secondary_index {
    name = "DataTable"
    hash_key = "sort"
    range_key = "sort_value"
    projection_type = "ALL"
  }

  stream_enabled = true
  stream_view_type = "NEW_IMAGE"
}

resource "aws_sns_topic" "entity-stream-fanout" {
  depends_on = ["aws_dynamodb_table.entities"]
  count = "${var.stream-count}"
  name = "${var.service}-${var.stage}-entity-stream-hook"
}

resource "aws_sqs_queue" "entity-stream-activity-feed-queue" {
  depends_on = [ "aws_dynamodb_table.entities" ]
  count = "${var.stream-count}"
  name = "${var.service}-${var.stage}-entity-stream-feed-queue"
}

resource "aws_sns_topic_subscription" "entity-stream-activity-feed-target" {
  depends_on = [ "aws_sns_topic.entity-stream-fanout", "aws_sqs_queue.entity-stream-activity-feed-queue" ]
  count = "${var.stream-count}"
  topic_arn = "${aws_sns_topic.entity-stream-fanout.arn}"
  protocol = "sqs"
  endpoint = "${aws_sqs_queue.entity-stream-activity-feed-queue.arn}"
}

resource "aws_lambda_event_source_mapping" "entities-stream" {
  depends_on = ["aws_dynamodb_table.entities"]
  count = "${var.stream-count}"
  batch_size = 100
  event_source_arn = "${aws_dynamodb_table.entities.stream_arn}"
  enabled = true
  function_name = "${var.entity-stream_arn}"
  starting_position = "TRIM_HORIZON"
}
