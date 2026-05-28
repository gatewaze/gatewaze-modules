# Accounts

Manage accounts (organizations and companies) with role-based user assignments. Accounts serve as a grouping mechanism for associating users with organizations that run events and competitions, with support for soft-delete deactivation and a full user membership model.

## How It Works

The Accounts module provides an admin interface for creating and managing organizational accounts. Each account has a name, URL slug, description, website, and contact information. Admin users can be assigned to accounts with one of four roles: owner, admin, member, or viewer. The module uses an `accounts_users` junction table to link admin profiles to accounts, and membership is managed through a dedicated modal interface. Accounts support soft deletion (deactivation) rather than permanent removal, so associated data is preserved. Access to account management is restricted to super admins, while other users can view accounts they belong to.

The service layer provides methods for CRUD operations on accounts, user assignment and role management, fetching accounts for the current user, and retrieving account members via an RPC call (`accounts_get_members`).

## Configuration

This module has no configurable settings.

## Features

- **accounts** -- Core account management (list, create, edit, deactivate)
- **accounts.manage** -- User assignment and role management within accounts
- Create accounts with name, slug, description, website, and contact details
- Auto-generate URL slugs from account names
- Assign admin users to accounts with role-based access (owner, admin, member, viewer)
- Update user roles and remove users from accounts (soft delete)
- Deactivate accounts without losing data
- RLS-filtered account listing based on user permissions
- Lookup accounts by ID or slug

## Dependencies

None.
