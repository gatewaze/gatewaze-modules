# Twilio SMS

Send SMS messages via the Twilio API for event invites, notifications, and reminders. Messages are delivered directly through Twilio's global SMS infrastructure with delivery tracking and logging.

## How It Works

When this module is enabled, SMS becomes available as a delivery channel for other modules. The event-invites module can send invite links via SMS instead of email, and the reminder system can trigger SMS reminders for pending RSVPs.

The module provides a Deno edge function (`sms-send`) that accepts a phone number and message body, calls the Twilio REST API, and logs the result. All sent messages are tracked in the `sms_send_log` table with Twilio SID, delivery status, and metadata.

Phone numbers must be in E.164 format (e.g., `+447700900000` or `+14155552671`).

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | string | Yes | Your Twilio Account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | string | Yes | Your Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | string | Yes | Twilio sender phone number in E.164 format |

Configure these in the module settings page after enabling the module. You can use the **Test Send** button to verify your credentials are working.

### Getting Twilio Credentials

1. Sign up at [twilio.com](https://www.twilio.com)
2. From the Twilio Console dashboard, copy your **Account SID** and **Auth Token**
3. Purchase a phone number with SMS capability, or use a Twilio trial number for testing
4. Enter these values in the module settings

## Features

- `twilio-sms` -- Core SMS functionality and configuration
- `twilio-sms.send` -- Send SMS messages via the Twilio API

## Dependencies

None. This module operates independently and is discovered at runtime by modules that support SMS delivery (e.g., event-invites).
