import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  TrashIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import {
  Card,
  Button,
  Input,
  Select,
  ConfirmModal,
} from '@/components/ui';
import { Calendar, CalendarService, UpdateCalendarInput, CalendarLocation } from '../services/calendarService';

interface CalendarSettingsTabProps {
  calendar: Calendar;
  onUpdate: () => void;
}

interface SettingsFormData {
  name: string;
  description: string;
  slug: string;
  visibility: 'public' | 'private' | 'unlisted';
  color: string;
  lumaCalendarId: string;
  externalUrl: string;
  // Location settings
  locationType: CalendarLocation['type'];
  locationCity: string;
  locationState: string;
  locationCountry: string;
  locationCountryCode: string;
  locationContinent: string;
}

const visibilityOptions = [
  { value: 'private', label: 'Private - Only visible to admins with permission' },
  { value: 'public', label: 'Public - Visible to everyone' },
  { value: 'unlisted', label: 'Unlisted - Accessible via direct link only' },
];

const locationTypeOptions = [
  { value: 'global', label: 'Global - No specific location' },
  { value: 'city', label: 'City - Specific city location' },
  { value: 'region', label: 'Region - State, province, or region' },
  { value: 'country', label: 'Country - Specific country' },
];

const continentOptions = [
  { value: '', label: 'Select continent...' },
  { value: 'Africa', label: 'Africa' },
  { value: 'Antarctica', label: 'Antarctica' },
  { value: 'Asia', label: 'Asia' },
  { value: 'Europe', label: 'Europe' },
  { value: 'North America', label: 'North America' },
  { value: 'Oceania', label: 'Oceania' },
  { value: 'South America', label: 'South America' },
];

export function CalendarSettingsTab({ calendar, onUpdate }: CalendarSettingsTabProps) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Get current location from settings
  const currentLocation = calendar.settings?.location as CalendarLocation | undefined;

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = useForm<SettingsFormData>({
    defaultValues: {
      name: calendar.name,
      description: calendar.description || '',
      slug: calendar.slug || '',
      visibility: calendar.visibility,
      color: calendar.color || '#3B82F6',
      lumaCalendarId: calendar.lumaCalendarId || '',
      externalUrl: calendar.externalUrl || '',
      // Location settings
      locationType: currentLocation?.type || 'global',
      locationCity: currentLocation?.city || '',
      locationState: currentLocation?.state || '',
      locationCountry: currentLocation?.country || '',
      locationCountryCode: currentLocation?.country_code || '',
      locationContinent: currentLocation?.continent || '',
    },
  });

  // Watch location type to conditionally show fields
  const locationType = watch('locationType');

  const onSubmit = async (data: SettingsFormData) => {
    setSaving(true);
    try {
      // Build location settings object
      const locationSettings: CalendarLocation = {
        type: data.locationType,
      };

      // Only include fields relevant to the location type
      if (data.locationType !== 'global') {
        if (data.locationCity) locationSettings.city = data.locationCity;
        if (data.locationState) locationSettings.state = data.locationState;
        if (data.locationCountry) locationSettings.country = data.locationCountry;
        if (data.locationCountryCode) locationSettings.country_code = data.locationCountryCode;
        if (data.locationContinent) locationSettings.continent = data.locationContinent;
      }

      const updateData: UpdateCalendarInput = {
        name: data.name,
        description: data.description || undefined,
        slug: data.slug || undefined,
        visibility: data.visibility,
        color: data.color || undefined,
        lumaCalendarId: data.lumaCalendarId || undefined,
        externalUrl: data.externalUrl || undefined,
        settings: {
          ...calendar.settings,
          location: locationSettings,
        },
      };

      const result = await CalendarService.updateCalendar(calendar.id, updateData);

      if (result.success) {
        toast.success('Settings saved');
        onUpdate();
      } else {
        toast.error(result.error || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await CalendarService.deleteCalendar(calendar.id);

      if (result.success) {
        toast.success('Calendar deleted');
        navigate('/calendars');
      } else {
        toast.error(result.error || 'Failed to delete calendar');
      }
    } catch (error) {
      console.error('Error deleting calendar:', error);
      toast.error('Failed to delete calendar');
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* General Settings */}
      <Card skin="shadow" className="p-6">
        <h3 className="text-lg font-semibold mb-4">General Settings</h3>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Calendar Name"
            {...register('name', { required: 'Name is required' })}
            error={errors.name?.message}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description
            </label>
            <textarea
              {...register('description')}
              rows={3}
              className="w-full px-3 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900 dark:text-white"
              placeholder="Optional description"
            />
          </div>

          <Input
            label="Slug"
            {...register('slug')}
            placeholder="my-calendar"
            helperText="URL-friendly identifier (optional)"
          />

          <Select
            label="Visibility"
            {...register('visibility')}
            data={visibilityOptions}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Color
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                {...register('color')}
                className="w-10 h-10 rounded cursor-pointer border border-gray-200 dark:border-gray-700"
              />
              <Input
                {...register('color')}
                placeholder="#3B82F6"
                className="flex-1"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Used for visual distinction in the UI
            </p>
          </div>

          <div className="flex justify-end pt-4">
            <Button type="submit" disabled={saving || !isDirty}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Integration Settings */}
      <Card skin="shadow" className="p-6">
        <h3 className="text-lg font-semibold mb-4">Integration Settings</h3>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Luma Calendar ID"
            {...register('lumaCalendarId')}
            placeholder="cal-xxx"
            helperText="Connect this calendar to a Luma calendar for syncing members"
          />

          <Input
            label="External URL"
            {...register('externalUrl')}
            placeholder="https://..."
            helperText="Link to an external calendar page"
          />

          <div className="flex justify-end pt-4">
            <Button type="submit" disabled={saving || !isDirty}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Location Settings */}
      <Card skin="shadow" className="p-6">
        <h3 className="text-lg font-semibold mb-4">Location Settings</h3>
        <p className="text-sm text-gray-500 mb-4">
          Set a geographic location for this calendar. When importing members, their location will be set to the calendar's location if they don't already have one.
        </p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Select
            label="Location Type"
            {...register('locationType')}
            data={locationTypeOptions}
          />

          {locationType !== 'global' && (
            <>
              {(locationType === 'city' || locationType === 'region') && (
                <Input
                  label="City"
                  {...register('locationCity')}
                  placeholder="San Francisco"
                  helperText="The city name"
                />
              )}

              {(locationType === 'city' || locationType === 'region') && (
                <Input
                  label="State / Region"
                  {...register('locationState')}
                  placeholder="California"
                  helperText="State, province, or region"
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Country"
                  {...register('locationCountry')}
                  placeholder="United States"
                  helperText="Full country name"
                />

                <Input
                  label="Country Code"
                  {...register('locationCountryCode')}
                  placeholder="US"
                  helperText="ISO 3166-1 alpha-2 code"
                  maxLength={2}
                  className="uppercase"
                />
              </div>

              <Select
                label="Continent"
                {...register('locationContinent')}
                data={continentOptions}
              />
            </>
          )}

          <div className="flex justify-end pt-4">
            <Button type="submit" disabled={saving || !isDirty}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Calendar Information */}
      <Card skin="shadow" className="p-6">
        <h3 className="text-lg font-semibold mb-4">Calendar Information</h3>

        <div className="space-y-3 text-sm">
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <span className="text-gray-500">Calendar ID</span>
            <span className="font-mono">{calendar.calendarId}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <span className="text-gray-500">Internal ID</span>
            <span className="font-mono text-xs">{calendar.id}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <span className="text-gray-500">Created</span>
            <span>{new Date(calendar.createdAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <span className="text-gray-500">Last Updated</span>
            <span>{new Date(calendar.updatedAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <span className="text-gray-500">Status</span>
            <span className={calendar.isActive ? 'text-green-600' : 'text-gray-500'}>
              {calendar.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          {calendar.defaultScraperId && (
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
              <span className="text-gray-500">Default Scraper ID</span>
              <span>{calendar.defaultScraperId}</span>
            </div>
          )}
          {calendar.accountId && (
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-800">
              <span className="text-gray-500">Account ID</span>
              <span className="font-mono text-xs">{calendar.accountId}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Danger Zone */}
      <Card skin="shadow" className="p-6 border-red-200 dark:border-red-800">
        <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-4 flex items-center gap-2">
          <ExclamationTriangleIcon className="size-5" />
          Danger Zone
        </h3>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Delete Calendar</p>
              <p className="text-sm text-gray-500">
                Permanently delete this calendar and all its data. This action cannot be undone.
              </p>
            </div>
            <Button
              variant="outlined"
              onClick={() => setShowDeleteConfirm(true)}
              className="text-red-600 border-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <TrashIcon className="size-4 mr-2" />
              Delete Calendar
            </Button>
          </div>
        </div>
      </Card>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Calendar"
        message={
          <div className="space-y-2">
            <p>Are you sure you want to delete <strong>"{calendar.name}"</strong>?</p>
            <p className="text-sm text-gray-500">
              This will remove the calendar and unlink all events and members.
              This action cannot be undone.
            </p>
          </div>
        }
        confirmText={deleting ? 'Deleting...' : 'Delete Calendar'}
        confirmVariant="danger"
      />
    </div>
  );
}
