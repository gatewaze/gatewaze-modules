import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, BuildingOfficeIcon, UsersIcon } from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as Yup from 'yup';
import { toast } from 'sonner';

import {
  Button,
  Card,
  Input,
  Badge,
  Modal,
  ConfirmModal,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { AccountService, CreateAccountData, UpdateAccountData } from '@/utils/accountService';
import { Account } from '@/lib/supabase';
import { useAuthContext } from '@/app/contexts/auth/context';
import { AccountUsersModal } from '@/components/accounts/AccountUsersModal';

interface AccountFormData {
  name: string;
  slug: string;
  description?: string;
  website?: string;
  contact_email?: string;
  contact_phone?: string;
}

const accountSchema = Yup.object().shape({
  name: Yup.string().required('Account name is required'),
  slug: Yup.string()
    .required('Slug is required')
    .matches(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  description: Yup.string(),
  website: Yup.string().url('Must be a valid URL'),
  contact_email: Yup.string().email('Must be a valid email'),
  contact_phone: Yup.string(),
});

export default function Accounts() {
  const { user: currentUser } = useAuthContext();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<Account | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [managingUsersAccount, setManagingUsersAccount] = useState<Account | null>(null);

  const isSuperAdmin = currentUser?.role === 'super_admin';

  const form = useForm<AccountFormData>({
    resolver: yupResolver(accountSchema) as any,
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      website: '',
      contact_email: '',
      contact_phone: '',
    },
  });

  const isEditing = !!editingAccount;

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const { accounts: fetchedAccounts, error } = await AccountService.getAllAccounts();
      if (error) {
        toast.error(error);
      } else {
        // Filter to only show active accounts
        const activeAccounts = (fetchedAccounts || []).filter(account => account.is_active !== false);
        setAccounts(activeAccounts);
      }
    } catch (error) {
      toast.error('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (account?: Account) => {
    if (account) {
      setEditingAccount(account);
      form.reset({
        name: account.name,
        slug: account.slug,
        description: account.description || '',
        website: account.website || '',
        contact_email: account.contact_email || '',
        contact_phone: account.contact_phone || '',
      });
    } else {
      setEditingAccount(null);
      form.reset({
        name: '',
        slug: '',
        description: '',
        website: '',
        contact_email: '',
        contact_phone: '',
      });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingAccount(null);
    form.reset();
  };

  const onSubmit = async (data: AccountFormData) => {
    setSubmitting(true);
    try {
      if (isEditing) {
        const updateData: UpdateAccountData = {
          name: data.name,
          slug: data.slug,
          description: data.description,
          website: data.website,
          contact_email: data.contact_email,
          contact_phone: data.contact_phone,
        };
        const { success, error } = await AccountService.updateAccount(editingAccount!.id, updateData);

        if (success) {
          toast.success('Account updated successfully');
          handleCloseModal();
          loadAccounts();
        } else {
          toast.error(error || 'Failed to update account');
        }
      } else {
        const createData: CreateAccountData = {
          name: data.name,
          slug: data.slug,
          description: data.description,
          website: data.website,
          contact_email: data.contact_email,
          contact_phone: data.contact_phone,
        };
        const { success, error } = await AccountService.createAccount(createData);

        if (success) {
          toast.success('Account created successfully');
          handleCloseModal();
          loadAccounts();
        } else {
          toast.error(error || 'Failed to create account');
        }
      }
    } catch (error) {
      toast.error('An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deleteAccount) return;

    try {
      const { success, error } = await AccountService.deactivateAccount(deleteAccount.id);

      if (success) {
        toast.success('Account deactivated successfully');
        setDeleteAccount(null);
        loadAccounts();
      } else {
        toast.error(error || 'Failed to deactivate account');
      }
    } catch (error) {
      toast.error('An error occurred while deactivating account');
    }
  };

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    form.setValue('name', name);

    // Only auto-generate slug if we're creating a new account
    if (!isEditing) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      form.setValue('slug', slug);
    }
  };

  return (
    <Page title="Accounts">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Accounts
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Manage organizations and companies that run competitions and events
            </p>
          </div>
          {isSuperAdmin && (
            <Button
              onClick={() => handleOpenModal()}
              color="primary"
              className="gap-2"
            >
              <PlusIcon className="size-4" />
              Add Account
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : (
          <Card className="overflow-hidden">
            <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>Account</Th>
                    <Th>Contact</Th>
                    <Th>Website</Th>
                    <Th>Created</Th>
                    <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                  </Tr>
                </THead>
                <TBody>
                  {accounts.map((account) => (
                    <Tr key={account.id}>
                      <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10 bg-primary-100 dark:bg-primary-900 rounded-lg flex items-center justify-center">
                            <BuildingOfficeIcon className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-[var(--gray-12)]">
                              {account.name}
                            </div>
                            <div className="text-sm text-[var(--gray-11)]">
                              {account.slug}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="text-sm text-[var(--gray-12)]">
                          {account.contact_email || '-'}
                        </div>
                        {account.contact_phone && (
                          <div className="text-sm text-[var(--gray-11)]">
                            {account.contact_phone}
                          </div>
                        )}
                      </Td>
                      <Td>
                        {account.website ? (
                          <a
                            href={account.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary-600 dark:text-primary-400 hover:underline"
                          >
                            Visit
                          </a>
                        ) : (
                          <span className="text-sm text-[var(--gray-a11)]">-</span>
                        )}
                      </Td>
                      <Td>
                        {new Date(account.created_at).toLocaleDateString()}
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          { label: "Manage Users", icon: <UsersIcon className="size-4" />, onClick: () => setManagingUsersAccount(account) },
                          { label: "Edit", icon: <PencilIcon className="size-4" />, onClick: () => handleOpenModal(account) },
                          { label: "Deactivate", icon: <TrashIcon className="size-4" />, onClick: () => setDeleteAccount(account), color: "red", hidden: !isSuperAdmin },
                        ]} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>

              {accounts.length === 0 && (
                <div className="text-center py-12">
                  <BuildingOfficeIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <p className="mt-2 text-[var(--gray-11)]">No accounts found</p>
                  {isSuperAdmin && (
                    <Button
                      onClick={() => handleOpenModal()}
                      color="primary"
                      className="mt-4 gap-2"
                    >
                      <PlusIcon className="size-4" />
                      Create First Account
                    </Button>
                  )}
                </div>
              )}
            </ScrollableTable>
          </Card>
        )}

        {/* Account Modal */}
        <Modal
          isOpen={showModal}
          onClose={handleCloseModal}
          title={isEditing ? 'Edit Account' : 'Add Account'}
        >
          <form onSubmit={form.handleSubmit(onSubmit as any)} className="space-y-4">
            <Input
              label="Account Name"
              placeholder="e.g., Acme Corporation"
              {...form.register('name')}
              onChange={handleNameChange}
              error={form.formState.errors.name?.message}
            />

            <div>
              <Input
                label="Slug"
                placeholder="e.g., acme-corporation"
                {...form.register('slug')}
                error={form.formState.errors.slug?.message}
              />
              <p className="mt-1 text-sm text-[var(--gray-11)]">
                Used in URLs. Only lowercase letters, numbers, and hyphens.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                Description
              </label>
              <textarea
                {...form.register('description')}
                rows={3}
                className="w-full px-3 py-2 border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="Brief description of the organization"
              />
              {form.formState.errors.description && (
                <p className="text-red-500 text-sm mt-1">{form.formState.errors.description.message}</p>
              )}
            </div>

            <Input
              label="Website"
              type="url"
              placeholder="https://example.com"
              {...form.register('website')}
              error={form.formState.errors.website?.message}
            />

            <Input
              label="Contact Email"
              type="email"
              placeholder="contact@example.com"
              {...form.register('contact_email')}
              error={form.formState.errors.contact_email?.message}
            />

            <Input
              label="Contact Phone"
              type="tel"
              placeholder="+1 (555) 123-4567"
              {...form.register('contact_phone')}
              error={form.formState.errors.contact_phone?.message}
            />

            <div className="flex justify-end space-x-3 pt-4">
              <Button
                type="button"
                variant="outlined"
                onClick={handleCloseModal}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                color="primary"
                disabled={submitting}
              >
                {isEditing ? 'Update Account' : 'Create Account'}
              </Button>
            </div>
          </form>
        </Modal>

        {/* Deactivate Confirmation Modal */}
        <ConfirmModal
          isOpen={!!deleteAccount}
          onClose={() => setDeleteAccount(null)}
          onConfirm={handleDeleteAccount}
          title="Deactivate Account"
          message={`Are you sure you want to deactivate ${deleteAccount?.name}? Users will no longer be able to access this account's events and competitions.`}
          confirmText="Deactivate"
          cancelText="Cancel"
        />

        {/* Account Users Management Modal */}
        {managingUsersAccount && (
          <AccountUsersModal
            isOpen={!!managingUsersAccount}
            onClose={() => setManagingUsersAccount(null)}
            accountId={managingUsersAccount.id}
            accountName={managingUsersAccount.name}
          />
        )}
      </div>
    </Page>
  );
}
