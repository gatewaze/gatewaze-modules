import { useState, useEffect } from 'react';
import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Modal, Button, Badge, ConfirmModal } from '@/components/ui';
import { AccountService } from '../utils/accountService';
import { AccountMemberDetail } from '@/lib/supabase';
import { AdminUserService } from '@/utils/adminUserService';
import { AdminUser } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface AccountUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  accountName: string;
}

const roleColors: Record<string, 'primary' | 'success' | 'warning' | 'secondary'> = {
  owner: 'warning',
  admin: 'primary',
  member: 'success',
  viewer: 'secondary',
};

export function AccountUsersModal({ isOpen, onClose, accountId, accountName }: AccountUsersModalProps) {
  const [members, setMembers] = useState<AccountMemberDetail[]>([]);
  const [availableUsers, setAvailableUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<'owner' | 'admin' | 'member' | 'viewer'>('member');
  const [submitting, setSubmitting] = useState(false);
  const [removingUser, setRemovingUser] = useState<AccountMemberDetail | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadMembers();
      loadAvailableUsers();
    }
  }, [isOpen, accountId]);

  const loadMembers = async () => {
    setLoading(true);
    try {
      const { members: fetchedMembers, error } = await AccountService.getAccountMembers(accountId);
      if (error) {
        toast.error(error);
      } else {
        setMembers(fetchedMembers || []);
      }
    } catch (error) {
      toast.error('Failed to load account members');
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableUsers = async () => {
    try {
      const { users, error } = await AdminUserService.getAllUsers();
      if (!error && users) {
        setAvailableUsers(users);
      }
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  const handleAddUser = async () => {
    if (!selectedUserId) {
      toast.error('Please select a user');
      return;
    }

    setSubmitting(true);
    try {
      const { success, error } = await AccountService.addAccountUser({
        account_id: accountId,
        admin_profile_id: selectedUserId,
        role: selectedRole,
      });

      if (success) {
        toast.success('User added to account successfully');
        setShowAddUser(false);
        setSelectedUserId('');
        setSelectedRole('member');
        loadMembers();
      } else {
        toast.error(error || 'Failed to add user');
      }
    } catch (error) {
      toast.error('An error occurred while adding user');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveUser = async () => {
    if (!removingUser) return;

    try {
      const { success, error } = await AccountService.removeAccountUser(removingUser.account_user_id);

      if (success) {
        toast.success('User removed from account');
        setRemovingUser(null);
        loadMembers();
      } else {
        toast.error(error || 'Failed to remove user');
      }
    } catch (error) {
      toast.error('An error occurred while removing user');
    }
  };

  const handleUpdateRole = async (accountUserId: string, newRole: 'owner' | 'admin' | 'member' | 'viewer') => {
    try {
      const { success, error } = await AccountService.updateAccountUserRole(accountUserId, newRole);

      if (success) {
        toast.success('User role updated');
        loadMembers();
      } else {
        toast.error(error || 'Failed to update role');
      }
    } catch (error) {
      toast.error('An error occurred while updating role');
    }
  };

  // Filter out users who are already members
  const usersNotInAccount = availableUsers.filter(
    user => !members.some(member => member.admin_profile_id === user.id)
  );

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Manage Users - ${accountName}`}
        size="lg"
      >
        <div className="space-y-4">
          {/* Add User Section */}
          {!showAddUser ? (
            <Button
              onClick={() => setShowAddUser(true)}
              color="primary"
              variant="outlined"
              className="gap-2 w-full"
            >
              <PlusIcon className="size-4" />
              Add User to Account
            </Button>
          ) : (
            <div className="border border-[var(--gray-a5)] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-[var(--gray-12)]">Add New User</h4>
                <button
                  onClick={() => {
                    setShowAddUser(false);
                    setSelectedUserId('');
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="size-5" />
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
                  Select User
                </label>
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="w-full px-3 py-2 border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-[var(--gray-a3)] text-[var(--gray-12)]"
                >
                  <option value="">Choose a user...</option>
                  {usersNotInAccount.map(user => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.email})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
                  Role
                </label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as any)}
                  className="w-full px-3 py-2 border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-[var(--gray-a3)] text-[var(--gray-12)]"
                >
                  <option value="owner">Owner - Full control</option>
                  <option value="admin">Admin - Can manage events</option>
                  <option value="member">Member - Can view and edit events</option>
                  <option value="viewer">Viewer - Read-only access</option>
                </select>
              </div>

              <div className="flex justify-end space-x-2">
                <Button
                  variant="outlined"
                  onClick={() => {
                    setShowAddUser(false);
                    setSelectedUserId('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  color="primary"
                  onClick={handleAddUser}
                  disabled={submitting || !selectedUserId}
                >
                  {submitting ? 'Adding...' : 'Add User'}
                </Button>
              </div>
            </div>
          )}

          {/* Members List */}
          <div>
            <h4 className="text-sm font-medium text-[var(--gray-12)] mb-3">
              Current Members ({members.length})
            </h4>

            {loading ? (
              <div className="flex justify-center py-8">
                <LoadingSpinner size="medium" />
              </div>
            ) : members.length === 0 ? (
              <div className="text-center py-8 text-[var(--gray-11)]">
                No users assigned to this account yet
              </div>
            ) : (
              <div className="space-y-2">
                {members.map((member) => (
                  <div
                    key={member.account_user_id}
                    className="flex items-center justify-between p-3 border border-[var(--gray-a5)] rounded-lg hover:bg-[var(--gray-a3)]"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--gray-12)]">
                          {member.user_name}
                        </span>
                        <Badge color={roleColors[member.account_role]}>
                          {member.account_role}
                        </Badge>
                      </div>
                      <div className="text-sm text-[var(--gray-11)]">
                        {member.user_email}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={member.account_role}
                        onChange={(e) => handleUpdateRole(member.account_user_id, e.target.value as any)}
                        className="px-2 py-1 text-sm border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-[var(--gray-a3)] text-[var(--gray-12)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>

                      <Button
                        color="error"
                        variant="outlined"
                        onClick={() => setRemovingUser(member)}
                        className="gap-1"
                      >
                        <TrashIcon className="size-3" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-4 border-t border-[var(--gray-a5)]">
            <Button onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      {/* Remove User Confirmation */}
      <ConfirmModal
        isOpen={!!removingUser}
        onClose={() => setRemovingUser(null)}
        onConfirm={handleRemoveUser}
        title="Remove User"
        message={`Are you sure you want to remove ${removingUser?.user_name} from this account? They will lose access to all events associated with this account.`}
        confirmText="Remove"
        cancelText="Cancel"
      />
    </>
  );
}
