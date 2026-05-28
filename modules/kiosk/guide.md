# Kiosk

On-site kiosk mode for event administrators. Search for registrants by email, name, or company and update their profile information (first name, last name, job title, company) in real time.

## How It Works

When an admin or super admin user is logged into the event portal, a "Kiosk" option appears in the event sidebar navigation. Tapping it opens a search interface where staff can look up any registrant for the current event and edit their details on the spot — ideal for check-in desks, badge printing stations, or information correction kiosks.

The search queries registrants by email address, first name, or last name. Selecting a result opens an inline edit form. Changes are saved directly to the person's profile and take effect immediately across the platform.

## Configuration

No configuration settings are required.

## Features

- `kiosk` -- Core kiosk search and display
- `kiosk.manage` -- Edit registrant information

## Dependencies

- `events` -- Requires the events module for event registration data
