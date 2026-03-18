import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PlusIcon, TrashIcon, PencilIcon, ChevronUpIcon, ChevronDownIcon, ArchiveBoxIcon, CheckCircleIcon, CreditCardIcon } from '@heroicons/react/24/outline';
import { Card, Button, Input, Modal, ConfirmModal } from '@/components/ui';
import { Cohort, CohortBenefit, CohortTestimonial } from '@/lib/cohorts/types';
import { CohortService } from '@/lib/cohorts';
import { supabase } from '@/lib/supabase';

interface CohortSettingsTabProps {
  cohort: Cohort;
  onUpdate: () => void;
}

export function CohortSettingsTab({ cohort, onUpdate }: CohortSettingsTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Helper function to convert ISO date to YYYY-MM-DD format for date inputs
  const toDateInputFormat = (isoDate: string) => {
    if (!isoDate) return '';
    return isoDate.split('T')[0];
  };

  // Check if edit mode should be enabled from URL parameter
  const shouldAutoEdit = searchParams.get('edit') === 'true';
  const [isEditingBasic, setIsEditingBasic] = useState(shouldAutoEdit);
  const [basicFormData, setBasicFormData] = useState({
    title: cohort.title,
    description: cohort.description || '',
    long_description: cohort.long_description || '',
    start_date: toDateInputFormat(cohort.start_date),
    end_date: toDateInputFormat(cohort.end_date),
    price_cents: cohort.price_cents,
    original_price_cents: cohort.original_price_cents,
    max_participants: cohort.max_participants,
    rating: cohort.rating,
    tags: cohort.tags || [],
    image: cohort.image || '',
    is_active: cohort.is_active,
    stripe_mode: cohort.stripe_mode || 'test',
    google_classroom_link: cohort.google_classroom_link || '',
    modules_heading: cohort.modules_heading || '',
    modules_description: cohort.modules_description || '',
    benefits_heading: cohort.benefits_heading || '',
    testimonials_heading: cohort.testimonials_heading || '',
    why_heading: cohort.why_heading || '',
    why_description: cohort.why_description || '',
  });

  const [benefits, setBenefits] = useState<CohortBenefit[]>([]);
  const [testimonials, setTestimonials] = useState<CohortTestimonial[]>([]);

  const [showBenefitModal, setShowBenefitModal] = useState(false);
  const [showTestimonialModal, setShowTestimonialModal] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [editingBenefit, setEditingBenefit] = useState<CohortBenefit | null>(null);
  const [editingTestimonial, setEditingTestimonial] = useState<CohortTestimonial | null>(null);
  const [benefitFormData, setBenefitFormData] = useState({ benefit: '', display_order: 1 });
  const [testimonialFormData, setTestimonialFormData] = useState({ name: '', role: '', content: '', rating: 5, display_order: 1 });

  useEffect(() => {
    loadBenefits();
    loadTestimonials();
  }, [cohort.id]);

  // Handle edit mode from URL parameter
  useEffect(() => {
    if (shouldAutoEdit) {
      setIsEditingBasic(true);
      // Remove the edit parameter from URL after enabling edit mode
      searchParams.delete('edit');
      setSearchParams(searchParams, { replace: true });
    }
  }, [shouldAutoEdit]);

  // Update form data when cohort changes
  useEffect(() => {
    setBasicFormData({
      title: cohort.title,
      description: cohort.description || '',
      long_description: cohort.long_description || '',
      start_date: toDateInputFormat(cohort.start_date),
      end_date: toDateInputFormat(cohort.end_date),
      price_cents: cohort.price_cents,
      original_price_cents: cohort.original_price_cents,
      max_participants: cohort.max_participants,
      rating: cohort.rating,
      tags: cohort.tags || [],
      image: cohort.image || '',
      is_active: cohort.is_active,
      stripe_mode: cohort.stripe_mode || 'test',
      google_classroom_link: cohort.google_classroom_link || '',
      modules_heading: cohort.modules_heading || '',
      modules_description: cohort.modules_description || '',
      benefits_heading: cohort.benefits_heading || '',
      testimonials_heading: cohort.testimonials_heading || '',
      why_heading: cohort.why_heading || '',
      why_description: cohort.why_description || '',
    });
  }, [cohort]);

  const loadBenefits = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_benefits')
        .select('*')
        .eq('cohort_id', cohort.id)
        .order('display_order', { ascending: true });

      if (error) throw error;
      console.log('Benefits data:', data); // Debug log
      setBenefits(data || []);
    } catch (error: any) {
      console.error('Error loading benefits:', error);
    }
  };

  const loadTestimonials = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_testimonials')
        .select('*')
        .eq('cohort_id', cohort.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      console.log('Testimonials data:', data); // Debug log
      setTestimonials(data || []);
    } catch (error: any) {
      console.error('Error loading testimonials:', error);
    }
  };


  const handleUpdateBasicSettings = async () => {
    try {
      const { error } = await CohortService.updateCohort(cohort.id, basicFormData);
      if (error) throw error;

      toast.success('Cohort updated successfully');
      setIsEditingBasic(false);
      onUpdate();
    } catch (error: any) {
      console.error('Error updating cohort:', error);
      toast.error('Failed to update cohort');
    }
  };

  const handleArchiveToggle = async () => {
    setIsArchiving(true);
    try {
      const { error } = await CohortService.updateCohort(cohort.id, { is_active: !cohort.is_active });
      if (error) throw error;

      toast.success(`Cohort ${cohort.is_active ? 'archived' : 'activated'} successfully`);
      setShowArchiveConfirm(false);
      onUpdate();
    } catch (error: any) {
      console.error('Error updating cohort:', error);
      toast.error('Failed to update cohort status');
    } finally {
      setIsArchiving(false);
    }
  };

  // Benefits handlers
  const handleAddBenefit = () => {
    setEditingBenefit(null);
    setBenefitFormData({ benefit: '', display_order: benefits.length + 1 });
    setShowBenefitModal(true);
  };

  const handleEditBenefit = (benefit: CohortBenefit) => {
    setEditingBenefit(benefit);
    setBenefitFormData({ benefit: benefit.benefit, display_order: benefit.display_order });
    setShowBenefitModal(true);
  };

  const handleSaveBenefit = async () => {
    try {
      if (editingBenefit) {
        const { error } = await supabase
          .from('cohorts_benefits')
          .update(benefitFormData)
          .eq('id', editingBenefit.id);
        if (error) throw error;
        toast.success('Benefit updated');
      } else {
        const { error } = await supabase
          .from('cohorts_benefits')
          .insert([{ ...benefitFormData, cohort_id: cohort.id, benefit_order: benefitFormData.display_order }]);
        if (error) throw error;
        toast.success('Benefit added');
      }
      setShowBenefitModal(false);
      loadBenefits();
    } catch (error: any) {
      console.error('Error saving benefit:', error);
      toast.error('Failed to save benefit');
    }
  };

  const handleDeleteBenefit = async (benefitId: number) => {
    if (!confirm('Are you sure you want to delete this benefit?')) return;

    try {
      const { error } = await supabase
        .from('cohorts_benefits')
        .delete()
        .eq('id', benefitId);
      if (error) throw error;
      toast.success('Benefit deleted');
      loadBenefits();
    } catch (error: any) {
      console.error('Error deleting benefit:', error);
      toast.error('Failed to delete benefit');
    }
  };

  const handleMoveBenefit = async (benefit: CohortBenefit, direction: 'up' | 'down') => {
    const currentIndex = benefits.findIndex(b => b.id === benefit.id);
    if (
      (direction === 'up' && currentIndex === 0) ||
      (direction === 'down' && currentIndex === benefits.length - 1)
    ) return;

    const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const swapBenefit = benefits[swapIndex];

    try {
      await supabase
        .from('cohorts_benefits')
        .update({ display_order: swapBenefit.display_order })
        .eq('id', benefit.id);

      await supabase
        .from('cohorts_benefits')
        .update({ display_order: benefit.display_order })
        .eq('id', swapBenefit.id);

      loadBenefits();
    } catch (error: any) {
      console.error('Error reordering benefits:', error);
      toast.error('Failed to reorder benefits');
    }
  };

  // Testimonials handlers
  const handleAddTestimonial = () => {
    setEditingTestimonial(null);
    setTestimonialFormData({ name: '', role: '', content: '', rating: 5, display_order: testimonials.length + 1 });
    setShowTestimonialModal(true);
  };

  const handleEditTestimonial = (testimonial: CohortTestimonial) => {
    setEditingTestimonial(testimonial);
    setTestimonialFormData({
      name: testimonial.name,
      role: testimonial.role || '',
      content: testimonial.content,
      rating: testimonial.rating || 5,
      display_order: testimonial.display_order
    });
    setShowTestimonialModal(true);
  };

  const handleSaveTestimonial = async () => {
    try {
      if (editingTestimonial) {
        const { error } = await supabase
          .from('cohorts_testimonials')
          .update(testimonialFormData)
          .eq('id', editingTestimonial.id);
        if (error) throw error;
        toast.success('Testimonial updated');
      } else {
        const { error } = await supabase
          .from('cohorts_testimonials')
          .insert([{ ...testimonialFormData, cohort_id: cohort.id }]);
        if (error) throw error;
        toast.success('Testimonial added');
      }
      setShowTestimonialModal(false);
      loadTestimonials();
    } catch (error: any) {
      console.error('Error saving testimonial:', error);
      toast.error('Failed to save testimonial');
    }
  };

  const handleDeleteTestimonial = async (testimonialId: number) => {
    if (!confirm('Are you sure you want to delete this testimonial?')) return;

    try {
      const { error } = await supabase
        .from('cohorts_testimonials')
        .delete()
        .eq('id', testimonialId);
      if (error) throw error;
      toast.success('Testimonial deleted');
      loadTestimonials();
    } catch (error: any) {
      console.error('Error deleting testimonial:', error);
      toast.error('Failed to delete testimonial');
    }
  };

  const handleMoveTestimonial = async (testimonial: CohortTestimonial, direction: 'up' | 'down') => {
    const currentIndex = testimonials.findIndex(t => t.id === testimonial.id);
    if (
      (direction === 'up' && currentIndex === 0) ||
      (direction === 'down' && currentIndex === testimonials.length - 1)
    ) return;

    const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const swapTestimonial = testimonials[swapIndex];

    try {
      await supabase
        .from('cohorts_testimonials')
        .update({ display_order: swapTestimonial.display_order })
        .eq('id', testimonial.id);

      await supabase
        .from('cohorts_testimonials')
        .update({ display_order: testimonial.display_order })
        .eq('id', swapTestimonial.id);

      loadTestimonials();
    } catch (error: any) {
      console.error('Error reordering testimonials:', error);
      toast.error('Failed to reorder testimonials');
    }
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Cohort Settings
        </h3>
        <div className="flex items-center gap-2">
          {isEditingBasic ? (
            <>
              <Button
                variant="outlined"
                size="sm"
                onClick={() => setIsEditingBasic(false)}
              >
                Cancel
              </Button>
              <Button
                color="primary"
                size="sm"
                onClick={handleUpdateBasicSettings}
              >
                Save Changes
              </Button>
            </>
          ) : (
            <Button
              color="primary"
              size="sm"
              onClick={() => setIsEditingBasic(true)}
            >
              <PencilIcon className="w-4 h-4 mr-2" />
              Edit
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* Basic Settings */}
        <Card>
          <div className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Basic Information
            </h3>

        {isEditingBasic ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Title</label>
              <Input
                value={basicFormData.title}
                onChange={(e) => setBasicFormData({ ...basicFormData, title: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Short Description</label>
              <textarea
                value={basicFormData.description}
                onChange={(e) => setBasicFormData({ ...basicFormData, description: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                rows={3}
                placeholder="Brief overview of the cohort..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Long Description</label>
              <textarea
                value={basicFormData.long_description}
                onChange={(e) => setBasicFormData({ ...basicFormData, long_description: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                rows={6}
                placeholder="Detailed description of what students will learn, course objectives, etc..."
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Start Date</label>
                <Input
                  type="date"
                  value={basicFormData.start_date}
                  onChange={(e) => setBasicFormData({ ...basicFormData, start_date: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">End Date</label>
                <Input
                  type="date"
                  value={basicFormData.end_date}
                  onChange={(e) => setBasicFormData({ ...basicFormData, end_date: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Current Price (USD)</label>
                <Input
                  type="number"
                  value={basicFormData.price_cents / 100}
                  onChange={(e) => setBasicFormData({ ...basicFormData, price_cents: parseFloat(e.target.value) * 100 })}
                  step="0.01"
                  placeholder="299.00"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Original Price (USD)</label>
                <Input
                  type="number"
                  value={basicFormData.original_price_cents ? basicFormData.original_price_cents / 100 : ''}
                  onChange={(e) => setBasicFormData({ ...basicFormData, original_price_cents: e.target.value ? parseFloat(e.target.value) * 100 : undefined })}
                  step="0.01"
                  placeholder="499.00"
                />
                <p className="text-xs text-gray-500 mt-1">Optional - shown as strikethrough</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Max Participants</label>
                <Input
                  type="number"
                  value={basicFormData.max_participants || ''}
                  onChange={(e) => setBasicFormData({ ...basicFormData, max_participants: parseInt(e.target.value) || undefined })}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Rating (out of 5)</label>
                <Input
                  type="number"
                  value={basicFormData.rating !== undefined ? basicFormData.rating : ''}
                  onChange={(e) => setBasicFormData({ ...basicFormData, rating: e.target.value ? parseFloat(e.target.value) : undefined })}
                  step="0.1"
                  min="0"
                  max="5"
                  placeholder="4.9"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Google Classroom Link</label>
              <Input
                value={basicFormData.google_classroom_link}
                onChange={(e) => setBasicFormData({ ...basicFormData, google_classroom_link: e.target.value })}
                placeholder="https://classroom.google.com/..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Image URL</label>
              <Input
                value={basicFormData.image}
                onChange={(e) => setBasicFormData({ ...basicFormData, image: e.target.value })}
                placeholder="https://example.com/image.jpg"
              />
              <p className="text-xs text-gray-500 mt-1">Optional - URL to cohort cover image</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Tags</label>
              <Input
                value={basicFormData.tags?.join(', ') || ''}
                onChange={(e) => setBasicFormData({ ...basicFormData, tags: e.target.value ? e.target.value.split(',').map(t => t.trim()).filter(t => t) : [] })}
                placeholder="machine-learning, python, data-science"
              />
              <p className="text-xs text-gray-500 mt-1">Optional - comma-separated tags</p>
            </div>

            {/* HTML Content Fields Section */}
            <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-md font-semibold mb-4 text-gray-900 dark:text-white">Front-End Content (HTML)</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Modules Section Heading</label>
                  <textarea
                    value={basicFormData.modules_heading}
                    onChange={(e) => setBasicFormData({ ...basicFormData, modules_heading: e.target.value })}
                    placeholder="<h2>What You'll Learn</h2>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Modules Section Description</label>
                  <textarea
                    value={basicFormData.modules_description}
                    onChange={(e) => setBasicFormData({ ...basicFormData, modules_description: e.target.value })}
                    placeholder="<p>Our comprehensive curriculum covers...</p>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Benefits Section Heading</label>
                  <textarea
                    value={basicFormData.benefits_heading}
                    onChange={(e) => setBasicFormData({ ...basicFormData, benefits_heading: e.target.value })}
                    placeholder="<h2>Why Join This Cohort</h2>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Testimonials Section Heading</label>
                  <textarea
                    value={basicFormData.testimonials_heading}
                    onChange={(e) => setBasicFormData({ ...basicFormData, testimonials_heading: e.target.value })}
                    placeholder="<h2>What Students Say</h2>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Why Section Heading</label>
                  <textarea
                    value={basicFormData.why_heading}
                    onChange={(e) => setBasicFormData({ ...basicFormData, why_heading: e.target.value })}
                    placeholder="<h2>Why This Matters</h2>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Why Section Description</label>
                  <textarea
                    value={basicFormData.why_description}
                    onChange={(e) => setBasicFormData({ ...basicFormData, why_description: e.target.value })}
                    placeholder="<p>This cohort will help you...</p>"
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is_active"
                checked={basicFormData.is_active}
                onChange={(e) => setBasicFormData({ ...basicFormData, is_active: e.target.checked })}
                className="rounded"
              />
              <label htmlFor="is_active" className="text-sm font-medium">
                Active (visible to students)
              </label>
            </div>

          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
                <p className="text-gray-900 dark:text-white">{formatDate(cohort.start_date)}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Date</label>
                <p className="text-gray-900 dark:text-white">{formatDate(cohort.end_date)}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Price</label>
                <p className="text-gray-900 dark:text-white">{formatCurrency(cohort.price_cents)}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Participants</label>
                <p className="text-gray-900 dark:text-white">{cohort.max_participants || 'Unlimited'}</p>
              </div>
            </div>
            {cohort.description && (
              <div className="pt-3 border-t dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <p className="text-gray-900 dark:text-white">{cohort.description}</p>
              </div>
            )}
          </div>
        )}
          </div>
        </Card>

        {/* Payment Settings */}
        <Card>
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <CreditCardIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Payment Settings
              </h3>
            </div>

            <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
              <div>
                <h4 className="font-medium text-gray-900 dark:text-white">
                  Stripe Payment Mode
                </h4>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {basicFormData.stripe_mode === 'live'
                    ? 'Live mode - Real payments will be processed'
                    : 'Test mode - Use Stripe test cards for testing'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-sm font-medium ${basicFormData.stripe_mode === 'test' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  Test
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const newMode = basicFormData.stripe_mode === 'live' ? 'test' : 'live';

                    // Confirm before switching to live mode
                    if (newMode === 'live') {
                      if (!confirm('Are you sure you want to enable LIVE payment mode? Real payments will be processed.')) {
                        return;
                      }
                    }

                    setBasicFormData({ ...basicFormData, stripe_mode: newMode });

                    // Immediately save the change
                    try {
                      const { error } = await CohortService.updateCohort(cohort.id, { stripe_mode: newMode });
                      if (error) throw error;
                      toast.success(`Stripe mode switched to ${newMode.toUpperCase()}`);
                      onUpdate();
                    } catch (error: any) {
                      console.error('Error updating stripe mode:', error);
                      toast.error('Failed to update payment mode');
                      // Revert on failure
                      setBasicFormData({ ...basicFormData, stripe_mode: basicFormData.stripe_mode });
                    }
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    basicFormData.stripe_mode === 'live'
                      ? 'bg-green-600 focus:ring-green-500'
                      : 'bg-gray-300 dark:bg-gray-600 focus:ring-blue-500'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      basicFormData.stripe_mode === 'live' ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className={`text-sm font-medium ${basicFormData.stripe_mode === 'live' ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  Live
                </span>
              </div>
            </div>

            {basicFormData.stripe_mode === 'live' && (
              <div className="mt-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  ⚠️ <strong>Live mode is enabled.</strong> All payments for this cohort will be processed with real money.
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* Benefits Section */}
        <Card>
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Benefits
              </h3>
              <Button color="primary" size="sm" onClick={handleAddBenefit}>
                <PlusIcon className="w-4 h-4 mr-2" />
                Add Benefit
              </Button>
            </div>

            {benefits.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-400 text-center py-8">
                No benefits added yet
              </p>
            ) : (
              <ul className="space-y-2">
                {benefits.map((benefit, index) => (
                  <li key={benefit.id} className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => handleMoveBenefit(benefit, 'up')}
                        disabled={index === 0}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronUpIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                      <button
                        onClick={() => handleMoveBenefit(benefit, 'down')}
                        disabled={index === benefits.length - 1}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronDownIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                    </div>
                    <span className="flex-1 text-gray-900 dark:text-white">{benefit.benefit}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEditBenefit(benefit)}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                      >
                        <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                      <button
                        onClick={() => handleDeleteBenefit(benefit.id)}
                        className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded"
                      >
                        <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Testimonials Section */}
        <Card>
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Testimonials
              </h3>
              <Button color="primary" size="sm" onClick={handleAddTestimonial}>
                <PlusIcon className="w-4 h-4 mr-2" />
                Add Testimonial
              </Button>
            </div>

            {testimonials.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-400 text-center py-8">
                No testimonials added yet
              </p>
            ) : (
              <div className="space-y-2">
                {testimonials.map((testimonial, index) => (
                  <div key={testimonial.id} className="flex items-start gap-2 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        onClick={() => handleMoveTestimonial(testimonial, 'up')}
                        disabled={index === 0}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronUpIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                      <button
                        onClick={() => handleMoveTestimonial(testimonial, 'down')}
                        disabled={index === testimonials.length - 1}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronDownIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                    </div>
                    <div className="flex-1">
                      <p className="text-gray-900 dark:text-white mb-2">"{testimonial.content}"</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        — {testimonial.name}
                        {testimonial.role && `, ${testimonial.role}`}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEditTestimonial(testimonial)}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                      >
                        <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      </button>
                      <button
                        onClick={() => handleDeleteTestimonial(testimonial.id)}
                        className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded"
                      >
                        <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Danger Zone */}
        <Card className="border-red-200 dark:border-red-900/50">
          <div className="p-6">
            <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-4">
              Danger Zone
            </h3>
            <div className="flex items-center justify-between p-4 bg-red-50 dark:bg-red-900/10 rounded-lg">
              <div>
                <h4 className="font-medium text-gray-900 dark:text-white">
                  {cohort.is_active ? 'Archive this cohort' : 'Activate this cohort'}
                </h4>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {cohort.is_active
                    ? 'Archiving will hide this cohort from students. You can reactivate it later.'
                    : 'Activating will make this cohort visible to students again.'}
                </p>
              </div>
              <Button
                color={cohort.is_active ? 'error' : 'primary'}
                variant="outlined"
                onClick={() => setShowArchiveConfirm(true)}
                className="shrink-0"
              >
                {cohort.is_active ? (
                  <>
                    <ArchiveBoxIcon className="w-4 h-4 mr-2" />
                    Archive Cohort
                  </>
                ) : (
                  <>
                    <CheckCircleIcon className="w-4 h-4 mr-2" />
                    Activate Cohort
                  </>
                )}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Archive Confirmation Modal */}
      <ConfirmModal
        isOpen={showArchiveConfirm}
        onClose={() => setShowArchiveConfirm(false)}
        onConfirm={handleArchiveToggle}
        title={cohort.is_active ? 'Archive Cohort' : 'Activate Cohort'}
        message={
          cohort.is_active
            ? `Are you sure you want to archive "${cohort.title}"? This will hide it from students but won't delete any data.`
            : `Are you sure you want to activate "${cohort.title}"? This will make it visible to students.`
        }
        confirmText={cohort.is_active ? 'Archive' : 'Activate'}
        confirmColor={cohort.is_active ? 'error' : 'primary'}
        isLoading={isArchiving}
      />

      {/* Benefit Modal */}
      <Modal
        isOpen={showBenefitModal}
        onClose={() => setShowBenefitModal(false)}
        title={editingBenefit ? 'Edit Benefit' : 'Add Benefit'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Benefit
            </label>
            <textarea
              value={benefitFormData.benefit}
              onChange={(e) => setBenefitFormData({ ...benefitFormData, benefit: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              rows={3}
              placeholder="Enter benefit text..."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => setShowBenefitModal(false)}>
              Cancel
            </Button>
            <Button color="primary" onClick={handleSaveBenefit}>
              {editingBenefit ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Testimonial Modal */}
      <Modal
        isOpen={showTestimonialModal}
        onClose={() => setShowTestimonialModal(false)}
        title={editingTestimonial ? 'Edit Testimonial' : 'Add Testimonial'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Student Name
            </label>
            <Input
              value={testimonialFormData.name}
              onChange={(e) => setTestimonialFormData({ ...testimonialFormData, name: e.target.value })}
              placeholder="Enter student name..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Role/Title (Optional)
            </label>
            <Input
              value={testimonialFormData.role}
              onChange={(e) => setTestimonialFormData({ ...testimonialFormData, role: e.target.value })}
              placeholder="e.g., Data Scientist at Company"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Testimonial
            </label>
            <textarea
              value={testimonialFormData.content}
              onChange={(e) => setTestimonialFormData({ ...testimonialFormData, content: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              rows={4}
              placeholder="Enter testimonial text..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Rating (1-5)
            </label>
            <Input
              type="number"
              min="1"
              max="5"
              value={testimonialFormData.rating}
              onChange={(e) => setTestimonialFormData({ ...testimonialFormData, rating: parseInt(e.target.value) || 5 })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => setShowTestimonialModal(false)}>
              Cancel
            </Button>
            <Button color="primary" onClick={handleSaveTestimonial}>
              {editingTestimonial ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
