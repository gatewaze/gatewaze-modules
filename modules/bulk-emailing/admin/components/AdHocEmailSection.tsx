/**
 * Ad-Hoc Email Section Component
 * Allows sending targeted emails to speakers and audience members
 * with filtering by status, checklist progress, and text search.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  PaperAirplaneIcon,
  UsersIcon,
  EyeIcon,
  PencilIcon,
  XMarkIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  UserGroupIcon,
  FunnelIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline';
import { Button, Select, ConfirmModal } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Form/Input';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import EmailService from '@/utils/emailService';
import EmailTemplateService, { EmailTemplate } from '@/utils/emailTemplateService';
import {
  replaceVariables,
  findAllVariables,
  type TemplateContext,
} from '@/utils/templateVariables';

// --- Types ---

type AudienceType = 'speakers' | 'audience';
type SpeakerStatusFilter = 'pending' | 'approved' | 'rejected' | 'reserve' | 'confirmed' | 'placeholder';
type ChecklistFilter = 'calendar_added' | 'presentation_submitted' | 'tracking_link_copied';
type AudienceSubType = 'interest' | 'registrants' | 'attendees';

interface RecipientInfo {
  id: string; // people_profile_id
  email: string;
  full_name: string;
  first_name: string;
  last_name: string;
  company: string;
  job_title: string;
  type: string; // e.g. 'speaker:approved', 'registrant', 'attendee', 'interest'
}

interface EmailBatchJob {
  id: string;
  event_id: string;
  email_type: string;
  subject_template: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  total_recipients: number;
  processed_count: number;
  success_count: number;
  fail_count: number;
  errors: any[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventDetails {
  event_title: string;
  event_city?: string;
  event_country_code?: string;
  event_start?: string;
  event_end?: string;
  event_location?: string;
  event_link?: string;
}

interface AdHocEmailSectionProps {
  eventId: string;
  eventUuid: string;
  userId: string;
  eventDetails: EventDetails | null;
  fromAddresses: ReturnType<typeof EmailService.getFromAddresses>;
  fromOptions: { label: string; value: string }[];
}

// --- Multi-select Dropdown Component ---

function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: Set<T>;
  onChange: (selected: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (value: T) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const selectedLabels = options
    .filter(o => selected.has(o.value))
    .map(o => o.label);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        <span className="truncate">
          {selectedLabels.length === 0
            ? label
            : selectedLabels.length <= 2
              ? selectedLabels.join(', ')
              : `${selectedLabels.length} selected`}
        </span>
        {open ? (
          <ChevronUpIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
        )}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {options.map(option => (
            <label
              key={option.value}
              className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => toggle(option.value)}
                className="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main Component ---

export function AdHocEmailSection({
  eventId,
  eventUuid,
  userId,
  eventDetails,
  fromAddresses,
  fromOptions,
}: AdHocEmailSectionProps) {
  // Audience selection state
  const [audienceType, setAudienceType] = useState<AudienceType>('speakers');
  const [speakerStatuses, setSpeakerStatuses] = useState<Set<SpeakerStatusFilter>>(new Set());
  const [checklistFilters, setChecklistFilters] = useState<Set<ChecklistFilter>>(new Set());
  const [audienceSubTypes, setAudienceSubTypes] = useState<Set<AudienceSubType>>(new Set());

  // Text filters
  const [nameFilter, setNameFilter] = useState('');
  const [jobTitleFilter, setJobTitleFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');

  // Recipients
  const [allRecipients, setAllRecipients] = useState<RecipientInfo[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [showRecipientList, setShowRecipientList] = useState(false);

  // Email composition state
  const [fromKey, setFromKey] = useState('events');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailContent, setEmailContent] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [cc, setCc] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Send state
  const [showTestSendModal, setShowTestSendModal] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [activeJob, setActiveJob] = useState<EmailBatchJob | null>(null);
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load templates
  useEffect(() => {
    if (userId) loadTemplates();
  }, [fromKey, userId]);

  // Load recipients when filters change
  useEffect(() => {
    loadRecipients();
  }, [audienceType, speakerStatuses, checklistFilters, audienceSubTypes, eventId, eventUuid]);

  // Check for active jobs on mount
  useEffect(() => {
    const checkActiveJob = async () => {
      const { data } = await supabase
        .from('email_batch_jobs')
        .select('*')
        .eq('event_id', eventId)
        .eq('email_type', 'adhoc_email')
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setActiveJob(data);
        setSending(true);
        startJobPolling(data.id);
      }
    };
    checkActiveJob();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [eventId]);

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const data = await EmailTemplateService.getTemplatesForAdmin(userId, fromKey);
      setTemplates(data.filter(t => t.template_type === 'member_email'));
    } catch (error) {
      console.error('Error loading templates:', error);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const loadRecipients = async () => {
    setLoadingRecipients(true);
    try {
      const recipients: RecipientInfo[] = [];

      if (audienceType === 'speakers') {
        const statusArray = [...speakerStatuses];
        if (statusArray.length === 0) {
          setAllRecipients([]);
          setLoadingRecipients(false);
          return;
        }

        // Fetch speakers with their talk data for checklist filtering
        let query = supabase
          .from('events_speakers_with_details')
          .select('id, people_profile_id, email, full_name, first_name, last_name, company, job_title, status, primary_talk_id, primary_talk_presentation_url, primary_talk_presentation_storage_path')
          .eq('event_uuid', eventUuid)
          .in('status', statusArray);

        const { data: speakers, error } = await query;
        if (error) throw error;

        if (speakers && speakers.length > 0) {
          // If checklist filters are active, fetch talk data for those fields
          let talkChecklistData: Record<string, { calendar_added: boolean; tracking_link_copied: boolean }> = {};

          if (checklistFilters.size > 0) {
            const talkIds = speakers
              .map(s => s.primary_talk_id)
              .filter(Boolean) as string[];

            if (talkIds.length > 0) {
              const { data: talks } = await supabase
                .from('events_talks')
                .select('id, calendar_added_at, tracking_link_copied_at')
                .in('id', talkIds);

              if (talks) {
                for (const talk of talks) {
                  talkChecklistData[talk.id] = {
                    calendar_added: !!talk.calendar_added_at,
                    tracking_link_copied: !!talk.tracking_link_copied_at,
                  };
                }
              }
            }
          }

          for (const s of speakers) {
            if (!s.email) continue;

            // Apply checklist filters
            if (checklistFilters.size > 0) {
              const talkData = s.primary_talk_id ? talkChecklistData[s.primary_talk_id] : null;
              const hasPresentation = !!(s.primary_talk_presentation_url || s.primary_talk_presentation_storage_path);

              let matchesChecklist = true;
              for (const filter of checklistFilters) {
                if (filter === 'calendar_added' && !talkData?.calendar_added) matchesChecklist = false;
                if (filter === 'presentation_submitted' && !hasPresentation) matchesChecklist = false;
                if (filter === 'tracking_link_copied' && !talkData?.tracking_link_copied) matchesChecklist = false;
              }
              if (!matchesChecklist) continue;
            }

            recipients.push({
              id: s.people_profile_id,
              email: s.email,
              full_name: s.full_name || s.email,
              first_name: s.first_name || '',
              last_name: s.last_name || '',
              company: s.company || '',
              job_title: s.job_title || '',
              type: `speaker:${s.status}`,
            });
          }
        }
      } else {
        // Audience type
        const subTypes = [...audienceSubTypes];
        if (subTypes.length === 0) {
          setAllRecipients([]);
          setLoadingRecipients(false);
          return;
        }

        const seenEmails = new Set<string>();

        if (subTypes.includes('interest')) {
          const { data, error } = await supabase
            .from('events_interest')
            .select(`
              id,
              email,
              people_profile_id,
              people_profiles(
                id,
                people!inner(
                  email, attributes
                )
              )
            `)
            .eq('event_id', eventId)
            .eq('status', 'active');

          if (error) throw error;
          if (data) {
            for (const row of data) {
              const customer = (row as any).people_profiles?.people;
              const email = customer?.email || row.email;
              if (!email || seenEmails.has(email.toLowerCase())) continue;
              seenEmails.add(email.toLowerCase());
              const attrs = customer?.attributes || {};
              recipients.push({
                id: row.people_profile_id || row.id,
                email,
                full_name: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim() || email,
                first_name: attrs.first_name || '',
                last_name: attrs.last_name || '',
                company: attrs.company || '',
                job_title: attrs.job_title || '',
                type: 'interest',
              });
            }
          }
        }

        if (subTypes.includes('registrants')) {
          const { data, error } = await supabase
            .from('events_registrations')
            .select(`
              id,
              people_profile_id,
              people_profiles!inner(
                id,
                people!inner(
                  email, attributes
                )
              )
            `)
            .eq('event_id', eventId)
            .eq('status', 'confirmed');

          if (error) throw error;
          if (data) {
            for (const row of data) {
              const customer = (row as any).people_profiles?.people;
              if (!customer?.email || seenEmails.has(customer.email.toLowerCase())) continue;
              seenEmails.add(customer.email.toLowerCase());
              const attrs = customer.attributes || {};
              recipients.push({
                id: (row as any).people_profiles?.id || row.people_profile_id,
                email: customer.email,
                full_name: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim() || customer.email,
                first_name: attrs.first_name || '',
                last_name: attrs.last_name || '',
                company: attrs.company || '',
                job_title: attrs.job_title || '',
                type: 'registrant',
              });
            }
          }
        }

        if (subTypes.includes('attendees')) {
          const { data, error } = await supabase
            .from('events_attendance')
            .select(`
              id,
              people_profile_id,
              people_profiles!inner(
                id,
                people!inner(
                  email, attributes
                )
              )
            `)
            .eq('event_id', eventId);

          if (error) throw error;
          if (data) {
            for (const row of data) {
              const customer = (row as any).people_profiles?.people;
              if (!customer?.email || seenEmails.has(customer.email.toLowerCase())) continue;
              seenEmails.add(customer.email.toLowerCase());
              const attrs = customer.attributes || {};
              recipients.push({
                id: (row as any).people_profiles?.id || row.people_profile_id,
                email: customer.email,
                full_name: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim() || customer.email,
                first_name: attrs.first_name || '',
                last_name: attrs.last_name || '',
                company: attrs.company || '',
                job_title: attrs.job_title || '',
                type: 'attendee',
              });
            }
          }
        }
      }

      setAllRecipients(recipients);
    } catch (error) {
      console.error('Error loading recipients:', error);
      toast.error('Failed to load recipients');
    } finally {
      setLoadingRecipients(false);
    }
  };

  // Apply text filters
  const filteredRecipients = useMemo(() => {
    return allRecipients.filter(r => {
      if (nameFilter.trim()) {
        const q = nameFilter.toLowerCase();
        if (!r.full_name.toLowerCase().includes(q)) return false;
      }
      if (jobTitleFilter.trim()) {
        const q = jobTitleFilter.toLowerCase();
        if (!r.job_title.toLowerCase().includes(q)) return false;
      }
      if (companyFilter.trim()) {
        const q = companyFilter.toLowerCase();
        if (!r.company.toLowerCase().includes(q)) return false;
      }
      if (emailFilter.trim()) {
        const q = emailFilter.toLowerCase();
        if (!r.email.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [allRecipients, nameFilter, jobTitleFilter, companyFilter, emailFilter]);

  const recipientCount = filteredRecipients.length;

  // Email template handling
  const handleTemplateSelect = async (selectedTemplateId: string) => {
    setTemplateId(selectedTemplateId || null);
    if (selectedTemplateId) {
      const template = templates.find(t => t.id === selectedTemplateId);
      if (template) {
        setEmailSubject(template.subject);
        setEmailContent(template.content_html);
      }
    } else {
      setEmailSubject('');
      setEmailContent('');
    }
  };

  // Preview context
  const buildPreviewContext = (
    email: string = 'recipient@example.com',
    firstName: string = 'Jane',
    lastName: string = 'Smith'
  ): TemplateContext => ({
    customer: {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      email,
    },
    ...(audienceType === 'speakers' ? {
      speaker: {
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`.trim(),
        email,
        talk_title: 'Building AI-Powered Applications',
        company: 'Tech Corp',
        job_title: 'Senior Engineer',
      },
    } : {}),
    event: {
      name: eventDetails?.event_title || '',
      city: eventDetails?.event_city || '',
      country: eventDetails?.event_country_code || '',
      start_date: eventDetails?.event_start ? new Date(eventDetails.event_start).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      }) : '',
      end_date: eventDetails?.event_end ? new Date(eventDetails.event_end).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      }) : '',
      link: eventDetails?.event_link || '',
      location: eventDetails?.event_location || '',
    },
  });

  const previewContext = useMemo(() => buildPreviewContext(), [eventDetails, audienceType]);
  const previewSubject = useMemo(() => replaceVariables(emailSubject, previewContext), [emailSubject, previewContext]);
  const previewContent = useMemo(() => replaceVariables(emailContent, previewContext), [emailContent, previewContext]);

  const hasTemplateVariables = useMemo(() => {
    const subjectVars = findAllVariables(emailSubject);
    const contentVars = findAllVariables(emailContent);
    return subjectVars.length > 0 || contentVars.length > 0;
  }, [emailSubject, emailContent]);

  // Test send
  const handleTestSend = async () => {
    if (!testEmailAddress.trim()) {
      toast.error('Please enter an email address');
      return;
    }
    if (!emailSubject.trim() || !emailContent.trim()) {
      toast.error('Please configure the email subject and content first');
      return;
    }

    setSendingTest(true);
    try {
      const context = buildPreviewContext(testEmailAddress, 'Test', 'User');
      const processedSubject = replaceVariables(emailSubject, context);
      const processedHtml = replaceVariables(emailContent, context);
      const fromAddress = fromAddresses[fromKey as keyof typeof fromAddresses] || fromAddresses.events;

      const result = await EmailService.sendEmail({
        to: [testEmailAddress],
        cc: cc || undefined,
        from: fromAddress || '',
        subject: `[TEST] ${processedSubject}`,
        html: processedHtml,
        replyTo: replyTo || undefined,
      });

      if (result.success) {
        toast.success(`Test email sent to ${testEmailAddress}`);
        setShowTestSendModal(false);
        setTestEmailAddress('');
      } else {
        toast.error(result.error || 'Failed to send test email');
      }
    } catch (error) {
      console.error('Error sending test email:', error);
      toast.error('Failed to send test email');
    } finally {
      setSendingTest(false);
    }
  };

  // Batch send
  const handleSend = async () => {
    if (!emailSubject.trim() || !emailContent.trim()) {
      toast.error('Please configure the email subject and content first');
      return;
    }
    if (recipientCount === 0) {
      toast.error('No recipients match your filters');
      return;
    }

    setSending(true);
    setShowSendConfirm(false);

    try {
      const fromAddress = fromAddresses[fromKey as keyof typeof fromAddresses] || fromAddresses.events;

      // Collect unique member_profile_ids from filtered recipients
      const memberProfileIds = [...new Set(filteredRecipients.map(r => r.id))];

      const { data: job, error: jobError } = await supabase
        .from('email_batch_jobs')
        .insert({
          event_id: eventId,
          email_type: 'adhoc_email',
          subject_template: emailSubject,
          content_template: emailContent,
          from_address: fromAddress || '',
          reply_to: replyTo || null,
          cc: cc || null,
          config: {
            member_profile_ids: memberProfileIds,
            audience_type: audienceType,
            event_uuid: eventUuid,
          },
          created_by: userId || null,
        })
        .select('*')
        .single();

      if (jobError || !job) throw jobError || new Error('Failed to create job');

      setActiveJob(job);

      await supabase.functions.invoke('email-batch-send', {
        body: { jobId: job.id },
      });

      startJobPolling(job.id);
      toast.success('Email send started in the background');
    } catch (error) {
      console.error('Error starting batch send:', error);
      toast.error('Failed to start email send');
      setSending(false);
    }
  };

  const startJobPolling = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const { data: job } = await supabase
        .from('email_batch_jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (!job) return;
      setActiveJob(job);

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        if (pollRef.current) clearInterval(pollRef.current);
        setSending(false);

        if (job.status === 'completed') {
          if (job.fail_count === 0) {
            toast.success(`Email sent to ${job.success_count} recipient${job.success_count !== 1 ? 's' : ''}`);
          } else {
            toast.warning(`Sent to ${job.success_count}, failed for ${job.fail_count}`);
          }
        } else if (job.status === 'cancelled') {
          toast.info(`Send cancelled. ${job.success_count} sent, ${job.total_recipients - job.processed_count} remaining.`);
        } else {
          toast.error('Email send failed');
        }

        if (job.success_count > 0 && templateId) {
          EmailTemplateService.incrementUsage(templateId).catch(console.error);
        }
      }
    }, 2000);
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    await supabase
      .from('email_batch_jobs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', activeJob.id);
  };

  const availableScopes = audienceType === 'speakers'
    ? ['speaker', 'customer', 'event'] as const
    : ['customer', 'event'] as const;

  const hasSelection = audienceType === 'speakers'
    ? speakerStatuses.size > 0
    : audienceSubTypes.size > 0;

  const getTypeBadgeColor = (type: string) => {
    if (type.startsWith('speaker:')) return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
    if (type === 'interest') return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300';
    if (type === 'registrant') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
    if (type === 'attendee') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  };

  const getTypeLabel = (type: string) => {
    if (type.startsWith('speaker:')) return type.replace('speaker:', '').charAt(0).toUpperCase() + type.replace('speaker:', '').slice(1);
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  return (
    <div className="space-y-6">
      {/* Audience Selection */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <FunnelIcon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <h4 className="text-base font-semibold text-gray-900 dark:text-white">Select Audience</h4>
        </div>

        {/* Audience Type Toggle */}
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => {
              setAudienceType('speakers');
              setAudienceSubTypes(new Set());
            }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              audienceType === 'speakers'
                ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 ring-1 ring-purple-300 dark:ring-purple-700'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            <MicrophoneIcon className="h-4 w-4" />
            Speakers
          </button>
          <button
            type="button"
            onClick={() => {
              setAudienceType('audience');
              setSpeakerStatuses(new Set());
              setChecklistFilters(new Set());
            }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              audienceType === 'audience'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 ring-1 ring-blue-300 dark:ring-blue-700'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            <UserGroupIcon className="h-4 w-4" />
            Audience
          </button>
        </div>

        {/* Type-specific filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {audienceType === 'speakers' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Speaker Status
                </label>
                <MultiSelectDropdown<SpeakerStatusFilter>
                  label="Select statuses..."
                  options={[
                    { value: 'pending', label: 'Pending' },
                    { value: 'approved', label: 'Approved' },
                    { value: 'rejected', label: 'Rejected' },
                    { value: 'reserve', label: 'Reserve' },
                    { value: 'confirmed', label: 'Confirmed' },
                    { value: 'placeholder', label: 'Placeholder' },
                  ]}
                  selected={speakerStatuses}
                  onChange={setSpeakerStatuses}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Checklist Progress
                </label>
                <MultiSelectDropdown<ChecklistFilter>
                  label="Filter by checklist..."
                  options={[
                    { value: 'calendar_added', label: 'Added to Calendar' },
                    { value: 'presentation_submitted', label: 'Presentation Submitted' },
                    { value: 'tracking_link_copied', label: 'Tracking Link Copied' },
                  ]}
                  selected={checklistFilters}
                  onChange={setChecklistFilters}
                />
              </div>
            </>
          ) : (
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Audience Type
              </label>
              <MultiSelectDropdown<AudienceSubType>
                label="Select audience types..."
                options={[
                  { value: 'interest', label: 'Expressed Interest' },
                  { value: 'registrants', label: 'Registrants' },
                  { value: 'attendees', label: 'Attendees (Checked In)' },
                ]}
                selected={audienceSubTypes}
                onChange={setAudienceSubTypes}
              />
            </div>
          )}
        </div>

        {/* Text Filters */}
        {hasSelection && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
              Further Filter Recipients
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="text"
                  value={nameFilter}
                  onChange={e => setNameFilter(e.target.value)}
                  placeholder="Name"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
                />
              </div>
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="text"
                  value={jobTitleFilter}
                  onChange={e => setJobTitleFilter(e.target.value)}
                  placeholder="Job Title"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
                />
              </div>
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="text"
                  value={companyFilter}
                  onChange={e => setCompanyFilter(e.target.value)}
                  placeholder="Company"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
                />
              </div>
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="text"
                  value={emailFilter}
                  onChange={e => setEmailFilter(e.target.value)}
                  placeholder="Email"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
                />
              </div>
            </div>
          </div>
        )}

        {/* Recipient Count & List */}
        {hasSelection && (
          <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UsersIcon className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                {loadingRecipients ? (
                  <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                    <LoadingSpinner size="xs" /> Loading...
                  </span>
                ) : (
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {recipientCount} recipient{recipientCount !== 1 ? 's' : ''} matched
                    {allRecipients.length !== recipientCount && (
                      <span className="text-gray-500 dark:text-gray-400 font-normal"> (of {allRecipients.length} total)</span>
                    )}
                  </span>
                )}
              </div>
              {recipientCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowRecipientList(!showRecipientList)}
                  className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                >
                  {showRecipientList ? 'Hide list' : 'Show list'}
                </button>
              )}
            </div>

            {showRecipientList && recipientCount > 0 && (
              <div className="mt-2 border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
                <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                  {filteredRecipients.map((r, idx) => (
                    <div key={`${r.id}-${idx}`} className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {r.full_name}
                          </span>
                          <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded-full ${getTypeBadgeColor(r.type)}`}>
                            {getTypeLabel(r.type)}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {r.email}
                          {(r.job_title || r.company) && (
                            <span> &middot; {[r.job_title, r.company].filter(Boolean).join(' at ')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Email Composition */}
      {hasSelection && recipientCount > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-5">
          <h4 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Compose Email</h4>

          <div className="space-y-4">
            {/* From Address */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                From Address
              </label>
              <Select
                value={fromKey}
                onChange={(e) => setFromKey(e.target.value)}
                data={fromOptions}
              />
            </div>

            {/* Email Template */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Load Template
              </label>
              <select
                value={templateId || ''}
                onChange={(e) => handleTemplateSelect(e.target.value)}
                disabled={loadingTemplates}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white disabled:opacity-50"
              >
                <option value="">
                  {loadingTemplates ? 'Loading templates...' : 'Start from scratch'}
                </option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Subject */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Subject
              </label>
              <input
                type="text"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder={`Enter email subject (use {{${audienceType === 'speakers' ? 'speaker' : 'customer'}.first_name}}, {{event.name}}, etc.)`}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
            </div>

            {/* Message Editor / Preview */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Message
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTestSendModal(true)}
                    disabled={!emailSubject.trim() || !emailContent.trim()}
                    className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <PaperAirplaneIcon className="h-4 w-4" />
                    Send Test
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPreview(!showPreview)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md flex items-center gap-1.5 ${
                      showPreview
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                        : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    {showPreview ? (
                      <>
                        <PencilIcon className="h-4 w-4" />
                        Edit
                      </>
                    ) : (
                      <>
                        <EyeIcon className="h-4 w-4" />
                        Preview
                      </>
                    )}
                  </button>
                </div>
              </div>

              {!showPreview && hasTemplateVariables && (
                <div className="mb-2 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    This message contains template variables. Each recipient will receive a personalized version.
                    Use the "Variables" button in the toolbar to insert dynamic content.
                  </p>
                </div>
              )}

              {showPreview ? (
                <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Preview for: Jane Smith (recipient@example.com)
                    </p>
                    <p className="text-sm font-medium text-gray-900 dark:text-white mt-1">
                      Subject: {previewSubject || '(No subject)'}
                    </p>
                  </div>
                  <div
                    className="p-4 prose prose-sm dark:prose-invert max-w-none overflow-y-auto bg-white dark:bg-gray-900"
                    style={{ minHeight: '250px', maxHeight: '400px' }}
                    dangerouslySetInnerHTML={{ __html: previewContent || '<p class="text-gray-400">(No content)</p>' }}
                  />
                </div>
              ) : (
                <div style={{ minHeight: '250px' }}>
                  <RichTextEditor
                    content={emailContent}
                    onChange={setEmailContent}
                    placeholder={`Enter your message here... Use the Variables button to insert dynamic content like {{${audienceType === 'speakers' ? 'speaker' : 'customer'}.first_name}}, {{event.name}}, etc.`}
                    templateVariables={{
                      enabled: true,
                      availableScopes: [...availableScopes],
                    }}
                  />
                </div>
              )}
            </div>

            {/* Reply-To */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Reply-To Address (optional)
              </label>
              <input
                type="email"
                value={replyTo || ''}
                onChange={(e) => setReplyTo(e.target.value || null)}
                placeholder="replies@example.com"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
            </div>

            {/* CC */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                CC Address (optional)
              </label>
              <input
                type="email"
                value={cc || ''}
                onChange={(e) => setCc(e.target.value || null)}
                placeholder="team@example.com"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
            </div>

            {/* Send Button / Progress */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50">
              {activeJob && (activeJob.status === 'pending' || activeJob.status === 'processing') ? (
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                      <span>Sending {activeJob.processed_count}/{activeJob.total_recipients}...</span>
                      <span>{activeJob.total_recipients > 0 ? Math.round((activeJob.processed_count / activeJob.total_recipients) * 100) : 0}%</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                      <div
                        className="bg-blue-600 h-2.5 rounded-full transition-all duration-500"
                        style={{ width: `${activeJob.total_recipients > 0 ? (activeJob.processed_count / activeJob.total_recipients) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-green-600 dark:text-green-400">{activeJob.success_count} sent</span>
                      {activeJob.fail_count > 0 && (
                        <span className="text-red-600 dark:text-red-400">{activeJob.fail_count} failed</span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelJob}
                      className="flex items-center gap-1 text-red-600 hover:text-red-700 border-red-300 hover:border-red-400"
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowSendConfirm(true)}
                    disabled={sending || !emailSubject.trim() || !emailContent.trim() || recipientCount === 0}
                    className="flex items-center gap-2"
                  >
                    <PaperAirplaneIcon className="h-4 w-4" />
                    Send to {recipientCount} Recipient{recipientCount !== 1 ? 's' : ''}
                  </Button>
                  {(!emailSubject.trim() || !emailContent.trim()) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                      Configure the email subject and content above to enable sending.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm Send Modal */}
      <ConfirmModal
        isOpen={showSendConfirm}
        onClose={() => setShowSendConfirm(false)}
        onConfirm={handleSend}
        title="Send Ad-Hoc Email"
        message={`Are you sure you want to send this email to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}? This action cannot be undone.`}
        confirmText="Send Emails"
        confirmVariant="primary"
      />

      {/* Test Send Modal */}
      <Modal
        isOpen={showTestSendModal}
        onClose={() => {
          setShowTestSendModal(false);
          setTestEmailAddress('');
        }}
        title="Send Test Email"
        size="md"
        footer={
          <div className="flex justify-end gap-3 px-6 py-4">
            <button
              onClick={() => {
                setShowTestSendModal(false);
                setTestEmailAddress('');
              }}
              disabled={sendingTest}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleTestSend}
              disabled={sendingTest || !testEmailAddress.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sendingTest ? (
                <>
                  <LoadingSpinner size="xs" />
                  Sending...
                </>
              ) : (
                <>
                  <PaperAirplaneIcon className="h-4 w-4" />
                  Send Test
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Send a test email to verify how the ad-hoc email will look.
            Template variables will be replaced with sample values.
          </p>
          <Input
            label="Email Address"
            type="email"
            value={testEmailAddress}
            onChange={(e) => setTestEmailAddress(e.target.value)}
            placeholder="your@email.com"
            disabled={sendingTest}
            description="The test email will be sent to this address with [TEST] prefix in the subject"
          />
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Preview:</p>
            <p className="text-sm text-gray-900 dark:text-white">
              <strong>Subject:</strong> [TEST] {previewSubject || '(No subject)'}
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
