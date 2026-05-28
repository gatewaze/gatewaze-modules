# Cohorts

Manage cohort-based learning programs with sessions, enrollments, resources, and instructors. This module provides a complete course management system for running paid or free training cohorts with structured weekly content, live sessions, and student progress tracking.

## How It Works

The module creates ten database tables that form the learning management system:

**Instructor Profiles** (`cohorts_instructor_profiles`) store instructor information including bio, specialty, rating, total student count, and featured status. Instructors are linked to people records in the system.

**Cohorts** (`cohorts`) are the main entity representing a training course. Each cohort has a title, description (short and long), start/end dates, pricing (in cents, with optional original price for showing discounts), maximum participants, tags, and an image. Cohorts support Stripe payment integration with test/live mode switching and Google Classroom links. Display customization fields control section headings for modules, benefits, testimonials, and "why" sections.

**Cohort Weeks** (`cohorts_weeks`) break a cohort into numbered weeks with titles, descriptions, and date ranges.

**Cohort Modules** (`cohorts_modules`) define the curriculum within weeks, each with a title, description, topics list, and display order.

**Cohort Enrollments** (`cohorts_enrollments`) track student signups with Stripe session IDs and payment status (pending, completed, failed, refunded).

**Cohort Resources** (`cohorts_resources`) attach materials to modules by week, supporting multiple types (video, document, link, Zoom, Slack) with member-only access controls.

**Cohort Live Sessions** (`cohorts_live_sessions`) schedule synchronous sessions with Zoom links, recording links, and timezone support.

**Cohort Benefits** (`cohorts_benefits`), **Testimonials** (`cohorts_testimonials`), and **User Progress** (`cohorts_user_progress`) round out the system with marketing content and per-user module completion tracking.

Three Edge Functions handle enrollment workflows: `cohorts-create-payment` creates Stripe checkout sessions, `cohorts-interest` captures interest/waitlist signups, and `cohorts-signup` processes enrollment completion.

The admin interface provides pages for cohort listing, detail management (with tabs), enrollments overview, instructor management (list and detail), resource management, and session scheduling.

## Configuration

This module has no configurable settings.

## Features

- **cohorts** -- Core cohort management (create, edit, list)
- **cohorts.sessions** -- Live session scheduling with Zoom integration and recordings
- **cohorts.enrollments** -- Student enrollment with Stripe payment processing
- **cohorts.resources** -- Learning resources by week/module (video, document, link, Zoom, Slack)
- **cohorts.instructors** -- Instructor profile management with ratings and specialties
- Structured weekly curriculum with modules and topics
- Stripe payment integration (test and live modes)
- Google Classroom integration
- Student progress tracking by module/week
- Marketing features: benefits lists, testimonials, pricing display
- Interest/waitlist capture
- Member-only resource access controls
- RLS policies (authenticated read, admin write)

## Dependencies

None.
