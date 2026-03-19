import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, PencilIcon, MagnifyingGlassIcon, EyeIcon, PhotoIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Modal, Input, Badge, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, InstructorProfile } from '../lib';
import { supabase } from '@/lib/supabase';
import { PeopleAvatarService } from '@/utils/peopleAvatarService';
import { PeopleService } from '@/utils/peopleService';

interface Member {
  id: number;
  cio_id: string;
  email: string;
  attributes?: {
    first_name?: string;
    last_name?: string;
  };
  avatar_storage_path?: string | null;
}

export default function InstructorsPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [instructors, setInstructors] = useState<InstructorProfile[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [totalMembers, setTotalMembers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [editingInstructor, setEditingInstructor] = useState<InstructorProfile | null>(null);
  const [deletingInstructor, setDeletingInstructor] = useState<InstructorProfile | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [memberSearchTerm, setMemberSearchTerm] = useState('');
  const [selectedMember, setSelectedMember] = useState<string>('');
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [wizardStep, setWizardStep] = useState<1 | 2>(1); // Wizard step for add modal
  const [formData, setFormData] = useState({
    instructor_name: '',
    email: '',
    bio: '',
    specialty: '',
    rating: 0,
    total_students: 0,
    is_featured: false,
    is_active: true,
  });

  useEffect(() => {
    loadInstructors();
  }, []);

  // Reload members when search term changes
  useEffect(() => {
    if (showAddModal && wizardStep === 1) {
      loadMembers();
    }
  }, [memberSearchTerm, showAddModal, wizardStep]);

  const loadInstructors = async () => {
    setLoading(true);
    try {
      const { data, error } = await CohortService.getInstructors();
      if (error) throw error;
      setInstructors(data);
    } catch (error: any) {
      console.error('Error loading instructors:', error);
      toast.error('Failed to load instructors');
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async () => {
    setLoadingMembers(true);
    try {
      // Use server-side filtering with pagination
      const { customers: fetchedMembers, total } = await PeopleService.getAuthenticatedPeoplePaginated(
        0, // page
        50, // pageSize
        'email', // sortBy
        'asc', // sortOrder
        memberSearchTerm || undefined // search term
      );

      // Get existing instructor customer IDs
      const existingInstructorIds = instructors.map(i => i.customer_cio_id);

      // Filter out members who are already instructors
      const availableMembers = fetchedMembers.filter(
        m => !existingInstructorIds.includes(m.cio_id)
      );

      setMembers(availableMembers as Member[]);
      setTotalMembers(total);
    } catch (error: any) {
      console.error('Error loading members:', error);
      toast.error('Failed to load members');
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Invalid file type. Please upload a JPEG, PNG, WebP, or GIF image.');
      return;
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large. Maximum size is 5MB.');
      return;
    }

    setSelectedFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleAvatarUpload = async () => {
    const customerId = selectedMemberId || selectedCustomerId;
    if (!selectedFile || !customerId) {
      toast.error('Please select a member and file');
      return;
    }

    setUploadingAvatar(true);
    try {
      const result = await PeopleAvatarService.uploadAvatar(customerId, selectedFile);
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload avatar');
      }

      toast.success('Avatar uploaded successfully');
      setSelectedFile(null);

      // Update the preview URL with the new avatar
      if (result.path) {
        const avatarUrl = PeopleAvatarService.getAvatarPublicUrl(result.path);
        setPreviewUrl(avatarUrl);
      }
    } catch (error: any) {
      console.error('Error uploading avatar:', error);
      toast.error(error.message || 'Failed to upload avatar');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAddClick = () => {
    loadMembers();
    resetForm();
    setShowAddModal(true);
  };

  const handleMemberSelect = (cioId: string) => {
    setSelectedMember(cioId);
    const member = members.find(m => m.cio_id === cioId);
    if (member) {
      setSelectedMemberId(member.id);

      // Pre-fill form with member data
      const firstName = member.attributes?.first_name || '';
      const lastName = member.attributes?.last_name || '';
      const instructorName = `${firstName} ${lastName}`.trim() || member.email;

      setFormData(prev => ({
        ...prev,
        instructor_name: instructorName,
        email: member.email,
      }));

      // If member has an avatar, use it
      if (member.avatar_storage_path) {
        const avatarUrl = PeopleAvatarService.getAvatarPublicUrl(member.avatar_storage_path);
        setPreviewUrl(avatarUrl);
      }
    }
  };

  const handleNextStep = () => {
    if (wizardStep === 1 && selectedMember) {
      setWizardStep(2);
    }
  };

  const handleBackStep = () => {
    if (wizardStep === 2) {
      setWizardStep(1);
    }
  };

  const handleAddInstructor = async () => {
    if (!selectedMember) {
      toast.error('Please select a member');
      return;
    }

    try {
      const member = members.find(m => m.cio_id === selectedMember);
      if (!member) throw new Error('Member not found');

      // Don't send instructor_name - it's a computed field from customers table
      const { instructor_name, ...profileData } = formData;
      const { error } = await CohortService.createInstructor(selectedMember, profileData);

      if (error) throw error;

      toast.success('Instructor added successfully');
      setShowAddModal(false);
      resetForm();
      loadInstructors();
    } catch (error: any) {
      console.error('Error adding instructor:', error);
      toast.error(error.message || 'Failed to add instructor');
    }
  };

  const handleEdit = async (instructor: InstructorProfile) => {
    setEditingInstructor(instructor);
    setFormData({
      instructor_name: instructor.instructor_name || '',
      email: instructor.email,
      bio: instructor.bio || '',
      specialty: instructor.specialty || '',
      rating: instructor.rating || 0,
      total_students: instructor.total_students || 0,
      is_featured: instructor.is_featured,
      is_active: instructor.is_active,
    });

    // Set the customer ID for avatar uploads
    setSelectedCustomerId(instructor.person_id);

    // Load existing avatar if available
    if (instructor.avatar_url) {
      const avatarUrl = PeopleAvatarService.getAvatarPublicUrl(instructor.avatar_url);
      setPreviewUrl(avatarUrl);
    }

    setShowEditModal(true);
  };

  const handleUpdateInstructor = async () => {
    if (!editingInstructor) return;

    try {
      // Update instructor profile (don't send instructor_name as it's not in the DB anymore)
      const { instructor_name, ...profileData } = formData;
      const { error: instructorError } = await CohortService.updateInstructor(
        editingInstructor.id,
        profileData
      );
      if (instructorError) throw instructorError;

      // Update customer record with name and email
      const { error: customerError } = await supabase
        .from('people')
        .update({
          email: formData.email,
          attributes: {
            first_name: formData.instructor_name.split(' ')[0] || '',
            last_name: formData.instructor_name.split(' ').slice(1).join(' ') || '',
          }
        })
        .eq('id', editingInstructor.person_id);

      if (customerError) {
        console.warn('Failed to update customer record:', customerError);
      }

      toast.success('Instructor updated successfully');
      setShowEditModal(false);
      setEditingInstructor(null);
      setSelectedCustomerId(null);
      resetForm();
      loadInstructors();
    } catch (error: any) {
      console.error('Error updating instructor:', error);
      toast.error(error.message || 'Failed to update instructor');
    }
  };

  const handleViewInstructor = (instructor: InstructorProfile) => {
    navigate(`/cohorts/instructors/${instructor.id}`);
  };

  const handleDeleteClick = (instructor: InstructorProfile) => {
    setDeletingInstructor(instructor);
    setShowDeleteModal(true);
  };

  const handleDeleteInstructor = async () => {
    if (!deletingInstructor) return;

    try {
      const { error } = await CohortService.deleteInstructor(deletingInstructor.id);
      if (error) throw error;

      toast.success('Instructor removed successfully. Customer and auth user remain intact.');
      setShowDeleteModal(false);
      setDeletingInstructor(null);
      loadInstructors();
    } catch (error: any) {
      console.error('Error deleting instructor:', error);
      toast.error(error.message || 'Failed to delete instructor');
    }
  };

  const resetForm = () => {
    setFormData({
      instructor_name: '',
      email: '',
      bio: '',
      specialty: '',
      rating: 0,
      total_students: 0,
      is_featured: false,
      is_active: true,
    });
    setSelectedMember('');
    setSelectedMemberId(null);
    setSelectedCustomerId(null);
    setSelectedFile(null);
    setPreviewUrl(null);
    setMemberSearchTerm('');
    setWizardStep(1);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const getMemberDisplay = (member: Member) => {
    const firstName = member.attributes?.first_name || '';
    const lastName = member.attributes?.last_name || '';
    const name = `${firstName} ${lastName}`.trim();
    return name ? `${name} (${member.email})` : member.email;
  };

  const filteredInstructors = instructors.filter(instructor =>
    instructor.instructor_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    instructor.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    instructor.specialty?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Page title="Manage Instructors">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Instructors
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {instructors.length} total instructors
            </p>
          </div>
          <Button
            variant="primary"
            className="flex items-center gap-2"
            onClick={handleAddClick}
          >
            <PlusIcon className="h-5 w-5" />
            Add Instructor
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <Input
            type="text"
            placeholder="Search instructors by name, email, or specialty..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Instructors Table */}
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="large" />
          </div>
        ) : filteredInstructors.length === 0 ? (
          <Card className="p-12 text-center">
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              {searchTerm ? 'No instructors match your search.' : 'No instructors found. Add your first instructor to get started.'}
            </p>
            {!searchTerm && (
              <Button
                variant="primary"
                onClick={handleAddClick}
              >
                <PlusIcon className="h-5 w-5 mr-2" />
                Add First Instructor
              </Button>
            )}
          </Card>
        ) : (
          <Card>
            <Table>
              <THead>
                <Tr>
                  <Th>Instructor</Th>
                  <Th>Specialty</Th>
                  <Th>Status</Th>
                  <Th>Stats</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {filteredInstructors.map((instructor) => (
                  <Tr key={instructor.id}>
                    <Td>
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          {instructor.avatar_url ? (
                            <img
                              className="h-10 w-10 rounded-full object-cover"
                              src={instructor.avatar_url}
                              alt={instructor.instructor_name}
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
                              {instructor.instructor_name.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="ml-4">
                          <div style={{ color: 'var(--gray-12)' }} className="text-sm font-medium">
                            {instructor.instructor_name}
                          </div>
                          <div style={{ color: 'var(--gray-11)' }} className="text-sm">
                            {instructor.email}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div style={{ color: 'var(--gray-12)' }} className="text-sm max-w-xs truncate">
                        {instructor.specialty || '-'}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex gap-2">
                        <Badge variant={instructor.is_active ? 'success' : 'secondary'}>
                          {instructor.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                        {instructor.is_featured && (
                          <Badge variant="primary">Featured</Badge>
                        )}
                      </div>
                    </Td>
                    <Td>
                      {instructor.rating && (
                        <div className="flex items-center gap-1">
                          <span className="text-yellow-500">★</span>
                          <span>{instructor.rating.toFixed(1)}</span>
                        </div>
                      )}
                      {instructor.total_students !== undefined && (
                        <div>{instructor.total_students} students</div>
                      )}
                    </Td>
                    <Td>
                      <RowActions actions={[
                        { label: 'View', icon: <EyeIcon className="size-4" />, onClick: () => handleViewInstructor(instructor) },
                        { label: 'Edit', icon: <PencilIcon className="size-4" />, onClick: () => handleEdit(instructor) },
                        { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => handleDeleteClick(instructor), color: 'red' },
                      ]} />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Card>
        )}

        {/* Add Instructor Modal */}
        <Modal
          isOpen={showAddModal}
          onClose={() => {
            setShowAddModal(false);
            resetForm();
          }}
          title={`Add New Instructor - Step ${wizardStep} of 2`}
          size="lg"
        >
          <div className="space-y-4">
            {/* Step Indicator */}
            <div className="flex items-center gap-2 pb-4 border-b dark:border-gray-700">
              <div className={`flex items-center gap-2 ${wizardStep === 1 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${wizardStep === 1 ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700'}`}>
                  1
                </div>
                <span className="text-sm font-medium">Select Member</span>
              </div>
              <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
              <div className={`flex items-center gap-2 ${wizardStep === 2 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${wizardStep === 2 ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-gray-700'}`}>
                  2
                </div>
                <span className="text-sm font-medium">Instructor Details</span>
              </div>
            </div>

            {/* Step 1: Select Member */}
            {wizardStep === 1 && (
            <div>
              <label className="block text-sm font-medium mb-1">
                Select Member {loadingMembers && <span className="text-xs text-gray-500">(Loading...)</span>}
              </label>

              {/* Search Input */}
              <div className="relative mb-2">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                </div>
                <Input
                  type="text"
                  placeholder="Search by name or email... (e.g., email:test@example.com)"
                  value={memberSearchTerm}
                  onChange={(e) => setMemberSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Member List */}
              {loadingMembers ? (
                <div className="flex justify-center items-center py-8 border rounded-lg dark:border-gray-700">
                  <LoadingSpinner size="small" />
                </div>
              ) : members.length === 0 ? (
                <div className="py-8 px-4 text-center border rounded-lg dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {memberSearchTerm
                      ? 'No members match your search. Try searching by email (e.g., email:test@example.com)'
                      : 'No available members found'}
                  </p>
                </div>
              ) : (
                <div className="border rounded-lg dark:border-gray-700 divide-y dark:divide-gray-700 max-h-80 overflow-y-auto">
                  {members.map((member) => {
                    const firstName = member.attributes?.first_name || '';
                    const lastName = member.attributes?.last_name || '';
                    const fullName = `${firstName} ${lastName}`.trim();
                    const isSelected = selectedMember === member.cio_id;

                    return (
                      <Button
                        key={member.cio_id}
                        type="button"
                        variant={isSelected ? 'soft' : 'ghost'}
                        color={isSelected ? 'blue' : 'gray'}
                        onClick={() => handleMemberSelect(member.cio_id)}
                      >
                        <div className="flex items-center gap-3">
                          {/* Avatar */}
                          <div className="flex-shrink-0">
                            {member.avatar_storage_path ? (
                              <img
                                src={PeopleAvatarService.getAvatarPublicUrl(member.avatar_storage_path)}
                                alt={fullName || member.email}
                                className="h-10 w-10 rounded-full object-cover"
                              />
                            ) : (
                              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-semibold">
                                {(fullName || member.email).charAt(0).toUpperCase()}
                              </div>
                            )}
                          </div>

                          {/* Member Info */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {fullName || member.email}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              {member.email}
                            </div>
                          </div>

                          {/* Selection Indicator */}
                          {isSelected && (
                            <div className="flex-shrink-0">
                              <div className="h-5 w-5 rounded-full bg-blue-500 flex items-center justify-center">
                                <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              </div>
                            </div>
                          )}
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}

              <p className="text-xs text-gray-500 mt-1">
                Only members who are not already instructors are shown
                {members.length > 0 && (
                  <> • Showing {members.length} of {totalMembers} total members{memberSearchTerm ? ' matching search' : ''}</>
                )}
              </p>
            </div>
            )}

            {/* Step 2: Instructor Details */}
            {wizardStep === 2 && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Instructor Name</label>
                    <Input
                      value={formData.instructor_name}
                      onChange={(e) => setFormData({ ...formData, instructor_name: e.target.value })}
                      placeholder="John Doe"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Email</label>
                    <Input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      placeholder="john@example.com"
                    />
                  </div>
                </div>

                {/* Avatar Upload */}
                <div>
                  <label className="block text-sm font-medium mb-2">Instructor Avatar</label>
                  <div className="flex items-start gap-4">
                    {/* Preview */}
                    <div className="flex-shrink-0">
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt="Avatar preview"
                          className="h-24 w-24 rounded-full object-cover border-2 border-gray-200 dark:border-gray-700"
                        />
                      ) : (
                        <div className="h-24 w-24 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-3xl font-bold">
                          {formData.instructor_name ? formData.instructor_name.charAt(0).toUpperCase() : '?'}
                        </div>
                      )}
                    </div>

                    {/* Upload Controls */}
                    <div className="flex-1 space-y-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadingAvatar}
                        >
                          <PhotoIcon className="h-4 w-4 mr-1" />
                          Choose Image
                        </Button>
                        {selectedFile && (
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={handleAvatarUpload}
                            disabled={uploadingAvatar}
                          >
                            {uploadingAvatar ? 'Uploading...' : 'Upload Avatar'}
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        {selectedFile
                          ? `Selected: ${selectedFile.name}`
                          : 'JPEG, PNG, WebP, or GIF (max 5MB)'}
                      </p>
                    </div>
                  </div>
                </div>

            <div>
              <label className="block text-sm font-medium mb-1">Bio</label>
              <textarea
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                rows={3}
                placeholder="Brief biography..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Specialty</label>
              <Input
                value={formData.specialty}
                onChange={(e) => setFormData({ ...formData, specialty: e.target.value })}
                placeholder="e.g., Machine Learning, NLP, Computer Vision"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Rating (1-5)</label>
                <Input
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  value={formData.rating}
                  onChange={(e) => setFormData({ ...formData, rating: parseFloat(e.target.value) || 0 })}
                  placeholder="4.5"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Number of Previous Students</label>
                <Input
                  type="number"
                  min="0"
                  value={formData.total_students}
                  onChange={(e) => setFormData({ ...formData, total_students: parseInt(e.target.value) || 0 })}
                  placeholder="0"
                />
              </div>
            </div>

            <p className="text-xs text-gray-500 -mt-2">
              These will eventually be calculated automatically based on cohort enrollments
            </p>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.is_featured}
                  onChange={(e) => setFormData({ ...formData, is_featured: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm font-medium">Featured Instructor</span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.is_active}
                  onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm font-medium">Active</span>
              </label>
            </div>
              </>
            )}

            {/* Footer with Navigation Buttons */}
            {wizardStep === 1 ? (
              <div className="flex gap-3 pt-4">
                <Button
                  variant="primary"
                  onClick={handleNextStep}
                  disabled={!selectedMember}
                  className="flex-1"
                >
                  Next: Instructor Details →
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowAddModal(false);
                    resetForm();
                  }}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex gap-3 pt-4">
                <Button
                  variant="primary"
                  onClick={handleAddInstructor}
                  className="flex-1"
                >
                  Add Instructor
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleBackStep}
                  className="flex-1"
                >
                  ← Back
                </Button>
              </div>
            )}
          </div>
        </Modal>

        {/* Edit Instructor Modal */}
        <Modal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setEditingInstructor(null);
            resetForm();
          }}
          title="Edit Instructor Profile"
          size="lg"
        >
          <div className="space-y-4">
            {/* Name and Email */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Instructor Name</label>
                <Input
                  value={formData.instructor_name}
                  onChange={(e) => setFormData({ ...formData, instructor_name: e.target.value })}
                  placeholder="John Doe"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>
            </div>

            {/* Avatar Upload */}
            {selectedCustomerId && (
              <div>
                <label className="block text-sm font-medium mb-2">Instructor Avatar</label>
                <div className="flex items-start gap-4">
                  {/* Preview */}
                  <div className="flex-shrink-0">
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt="Avatar preview"
                        className="h-24 w-24 rounded-full object-cover border-2 border-gray-200 dark:border-gray-700"
                      />
                    ) : (
                      <div className="h-24 w-24 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-3xl font-bold">
                        {formData.instructor_name ? formData.instructor_name.charAt(0).toUpperCase() : '?'}
                      </div>
                    )}
                  </div>

                  {/* Upload Controls */}
                  <div className="flex-1 space-y-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingAvatar}
                      >
                        <PhotoIcon className="h-4 w-4 mr-1" />
                        Choose Image
                      </Button>
                      {selectedFile && (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleAvatarUpload}
                          disabled={uploadingAvatar}
                        >
                          {uploadingAvatar ? 'Uploading...' : 'Upload Avatar'}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">
                      {selectedFile
                        ? `Selected: ${selectedFile.name}`
                        : 'JPEG, PNG, WebP, or GIF (max 5MB)'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1">Bio</label>
              <textarea
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                rows={3}
                placeholder="Brief biography..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Specialty</label>
              <Input
                value={formData.specialty}
                onChange={(e) => setFormData({ ...formData, specialty: e.target.value })}
                placeholder="e.g., Machine Learning, NLP, Computer Vision"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Rating (1-5)</label>
                <Input
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  value={formData.rating}
                  onChange={(e) => setFormData({ ...formData, rating: parseFloat(e.target.value) || 0 })}
                  placeholder="4.5"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Number of Previous Students</label>
                <Input
                  type="number"
                  min="0"
                  value={formData.total_students}
                  onChange={(e) => setFormData({ ...formData, total_students: parseInt(e.target.value) || 0 })}
                  placeholder="0"
                />
              </div>
            </div>
            <p className="text-xs text-gray-500 -mt-2">
              These will eventually be calculated automatically based on cohort enrollments
            </p>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.is_featured}
                  onChange={(e) => setFormData({ ...formData, is_featured: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm font-medium">Featured Instructor</span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.is_active}
                  onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                  className="rounded"
                />
                <span className="text-sm font-medium">Active</span>
              </label>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                variant="primary"
                onClick={handleUpdateInstructor}
                className="flex-1"
              >
                Update Instructor
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowEditModal(false);
                  setEditingInstructor(null);
                  resetForm();
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>

        {/* Delete Confirmation Modal */}
        <Modal
          isOpen={showDeleteModal}
          onClose={() => {
            setShowDeleteModal(false);
            setDeletingInstructor(null);
          }}
          title="Delete Instructor"
          size="md"
        >
          <div className="space-y-4">
            <p className="text-gray-700 dark:text-gray-300">
              Are you sure you want to remove <strong>{deletingInstructor?.instructor_name}</strong> from the instructors list?
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              This will only remove them as an instructor. Their customer record and auth user will remain intact.
            </p>

            <div className="flex gap-3 pt-4">
              <Button
                variant="danger"
                onClick={handleDeleteInstructor}
                className="flex-1"
              >
                Delete Instructor
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeletingInstructor(null);
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </Page>
  );
}
