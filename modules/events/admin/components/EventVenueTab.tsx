import { useCallback, useEffect, useState } from 'react';
import {
  MapPinIcon,
  PlusIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  BuildingOffice2Icon,
} from '@heroicons/react/24/outline';
import { Card, Input, Button, Badge } from '@/components/ui';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { EventImageUpload } from '@/components/events/EventImageUpload';
import {
  geocodePostcode,
  getDrivingRoute,
  formatDistance,
  formatDuration,
  haversineMeters,
} from '../../lib/geocoding';
import { EventService, type Event, type NearbyHotel } from '@/utils/eventService';
import { toast } from 'sonner';

interface EventVenueTabProps {
  event: Event;
  isEditMode: boolean;
  // RHF helpers from the parent EventDetailPage.
  // The parent owns the event form schema; this tab edits a slice of it
  // (venueAddress, venueContent, venueMapImage, nearbyHotels).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errors: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  watch: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setValue: any;
}

export function EventVenueTab({ event, isEditMode, register, errors, watch, setValue }: EventVenueTabProps) {
  // Accommodation list persists directly to events.nearby_hotels on each
  // add/remove rather than riding the parent form's submit. Round-tripping
  // a JSONB array through react-hook-form's hidden-input/setValue plumbing
  // proved fragile (DOM value="" overwriting the array on submit), and
  // direct persistence sidesteps that entirely.
  const [hotels, setHotels] = useState<NearbyHotel[]>(event.nearbyHotels ?? []);
  // Re-sync if the parent event prop changes (e.g. after a parent save reload)
  useEffect(() => {
    setHotels(event.nearbyHotels ?? []);
  }, [event.nearbyHotels]);

  const venueLat = event.eventLatitude ?? null;
  const venueLng = event.eventLongitude ?? null;
  const sortedHotels = sortHotelsByProximity(hotels, venueLat, venueLng);

  const persistHotels = useCallback(
    async (next: NearbyHotel[]) => {
      const previous = hotels;
      setHotels(next); // optimistic
      if (!event.id) {
        toast.error('Save the event first before adding accommodation');
        setHotels(previous);
        return;
      }
      try {
        const result = await EventService.updateEvent(event.id, { nearbyHotels: next });
        if (!result.success) {
          throw new Error(result.error || 'update failed');
        }
      } catch (err) {
        console.error('Failed to persist nearby hotels', err);
        toast.error('Failed to save accommodation');
        setHotels(previous);
      }
    },
    [event.id, hotels],
  );

  const removeHotel = useCallback(
    (id: string) => {
      void persistHotels(hotels.filter((h) => h.id !== id));
    },
    [hotels, persistHotels],
  );

  const upsertHotel = useCallback(
    (hotel: NearbyHotel) => {
      const idx = hotels.findIndex((h) => h.id === hotel.id);
      const next = idx === -1 ? [...hotels, hotel] : hotels.map((h) => (h.id === hotel.id ? hotel : h));
      void persistHotels(next);
    },
    [hotels, persistHotels],
  );

  return (
    <div className="space-y-6">
      {/* Address + coords */}
      <Card className="overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow duration-300">
        <div className="p-6">
          <CardHeader
            icon={<MapPinIcon className="w-5 h-5 text-[var(--green-11)]" />}
            iconBg="bg-green-50 dark:bg-green-900/20"
            title="Venue Location"
            subtitle="Address + coordinates used for distance calculations"
          />
          <div className="space-y-4">
            {isEditMode ? (
              <Input
                label="Venue Address"
                {...register('venueAddress')}
                error={errors.venueAddress?.message}
                placeholder="e.g. Computer History Museum, 1401 N Shoreline Blvd"
              />
            ) : (
              <ReadField label="Venue Address" value={event.venueAddress} />
            )}

            <div className="grid grid-cols-2 gap-4">
              {isEditMode ? (
                <Input
                  label="Latitude"
                  type="number"
                  step="any"
                  {...register('eventLatitude', { valueAsNumber: true })}
                  error={errors.eventLatitude?.message}
                  placeholder="e.g. 54.7766"
                />
              ) : (
                <ReadField label="Latitude" value={event.eventLatitude?.toString()} />
              )}
              {isEditMode ? (
                <Input
                  label="Longitude"
                  type="number"
                  step="any"
                  {...register('eventLongitude', { valueAsNumber: true })}
                  error={errors.eventLongitude?.message}
                  placeholder="e.g. -1.5742"
                />
              ) : (
                <ReadField label="Longitude" value={event.eventLongitude?.toString()} />
              )}
            </div>
            {isEditMode && (
              <p className="text-xs text-[var(--gray-a11)]">
                Coordinates power the venue map and the &ldquo;distance from venue&rdquo; calculation
                shown on each nearby hotel.
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Venue rich content + floor plan */}
      <Card className="overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow duration-300">
        <div className="p-6">
          <CardHeader
            icon={<MapPinIcon className="w-5 h-5 text-[var(--green-11)]" />}
            iconBg="bg-green-50 dark:bg-green-900/20"
            title="Venue Details"
            subtitle="Parking, transport, directions — shown on the venue page"
          />
          {isEditMode ? (
            <>
              <RichTextEditor
                content={watch('venueContent') || ''}
                onChange={(content: string) => setValue('venueContent', content, { shouldDirty: true })}
                placeholder="Write venue details (parking, transport, accessibility info)..."
              />
              <div className="mt-4">
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                  Indoor Venue Map / Floor Plan
                </label>
                <EventImageUpload
                  value={watch('venueMapImage') || undefined}
                  onChange={(url: string | null) =>
                    setValue('venueMapImage', url || '', { shouldDirty: true })
                  }
                  eventId={event.eventId}
                  type="logo"
                  label="Upload floor plan image"
                />
              </div>
            </>
          ) : (
            <div>
              {event.venueContent ? (
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: event.venueContent }}
                />
              ) : (
                <p className="text-sm text-[var(--gray-a11)] italic">No venue details configured.</p>
              )}
              {event.venueMapImage && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-[var(--gray-11)] mb-2">Floor Plan</p>
                  <img src={event.venueMapImage} alt="Venue map" className="max-w-full rounded-lg border border-[var(--gray-a6)]" />
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Nearby hotels editor */}
      <Card className="overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow duration-300">
        <div className="p-6">
          <CardHeader
            icon={<BuildingOffice2Icon className="w-5 h-5 text-[var(--blue-11)]" />}
            iconBg="bg-blue-50 dark:bg-blue-900/20"
            title="Nearby Accommodation"
            subtitle="Hotels and stays shown on the venue page map, ascending by distance"
          />

          {sortedHotels.length === 0 && !isEditMode && (
            <p className="text-sm text-[var(--gray-a11)] italic">No nearby accommodation added yet.</p>
          )}

          <div className="space-y-3">
            {sortedHotels.map((hotel) => (
              <HotelRow
                key={hotel.id}
                hotel={hotel}
                venueLat={venueLat}
                venueLng={venueLng}
                isEditMode={isEditMode}
                onRemove={() => removeHotel(hotel.id)}
              />
            ))}
          </div>

          {isEditMode && (
            <div className="mt-6 pt-6 border-t border-[var(--gray-a6)]">
              <AddHotelForm
                venueLat={venueLat}
                venueLng={venueLng}
                onAdd={upsertHotel}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CardHeader({
  icon,
  iconBg,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
      <div>
        <h3 className="text-lg font-bold text-[var(--gray-12)]">{title}</h3>
        <span className="text-xs text-[var(--gray-a11)]">{subtitle}</span>
      </div>
    </div>
  );
}

function ReadField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">{label}</label>
      <p className="text-[var(--gray-12)]">{value || 'N/A'}</p>
    </div>
  );
}

function HotelRow({
  hotel,
  venueLat,
  venueLng,
  isEditMode,
  onRemove,
}: {
  hotel: NearbyHotel;
  venueLat: number | null;
  venueLng: number | null;
  isEditMode: boolean;
  onRemove: () => void;
}) {
  const distLabel = formatHotelDistance(hotel, venueLat, venueLng);
  const driveLabel = hotel.driveSeconds != null ? formatDuration(hotel.driveSeconds) : null;

  return (
    <div className="flex items-start justify-between gap-4 p-4 rounded-lg border border-[var(--gray-a6)] bg-[var(--color-panel)]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-[var(--gray-12)]">{hotel.name}</p>
          {hotel.priceRange && <Badge variant="soft">{hotel.priceRange}</Badge>}
          {hotel.lat == null && (
            <Badge variant="soft" color="orange">Not geocoded</Badge>
          )}
        </div>
        <div className="text-xs text-[var(--gray-a11)] mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span>{hotel.postcode}</span>
          {distLabel && <span>{distLabel} from venue</span>}
          {driveLabel && <span>~{driveLabel} by car</span>}
        </div>
        {hotel.url && (
          <a
            href={hotel.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs mt-2 text-[var(--accent-11)] hover:underline"
          >
            Visit website
            <ArrowTopRightOnSquareIcon className="w-3 h-3" />
          </a>
        )}
      </div>
      {isEditMode && (
        <Button variant="soft" color="red" onClick={onRemove}>
          <TrashIcon className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}

function AddHotelForm({
  venueLat,
  venueLng,
  onAdd,
}: {
  venueLat: number | null;
  venueLng: number | null;
  onAdd: (hotel: NearbyHotel) => void;
}) {
  const [name, setName] = useState('');
  const [postcode, setPostcode] = useState('');
  const [url, setUrl] = useState('');
  const [priceRange, setPriceRange] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setPostcode('');
    setUrl('');
    setPriceRange('');
  };

  const handleAdd = async () => {
    if (!name.trim()) {
      toast.error('Hotel name is required');
      return;
    }
    if (!postcode.trim()) {
      toast.error('Postcode / ZIP is required');
      return;
    }
    setSubmitting(true);
    try {
      const geocoded = await geocodePostcode(postcode.trim());
      if (!geocoded) {
        toast.warning(`Couldn't geocode "${postcode}" — added without coordinates`);
      }

      let driveSeconds: number | null = null;
      let driveDistanceMeters: number | null = null;
      if (geocoded && venueLat != null && venueLng != null) {
        const route = await getDrivingRoute(
          { lat: geocoded.lat, lng: geocoded.lng },
          { lat: venueLat, lng: venueLng },
        );
        if (route) {
          driveSeconds = route.durationSeconds;
          driveDistanceMeters = route.distanceMeters;
        }
      }

      const newHotel: NearbyHotel = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `h-${Date.now()}`,
        name: name.trim(),
        postcode: postcode.trim(),
        url: url.trim() || null,
        priceRange: priceRange.trim() || null,
        lat: geocoded?.lat ?? null,
        lng: geocoded?.lng ?? null,
        geocodedAt: geocoded ? new Date().toISOString() : null,
        driveSeconds,
        driveDistanceMeters,
      };
      onAdd(newHotel);
      reset();
      if (geocoded) toast.success(`Added ${newHotel.name}`);
    } catch (err) {
      console.error('Failed to add hotel', err);
      toast.error('Failed to add hotel');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-[var(--gray-11)]">Add accommodation</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          label="Hotel name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Premier Inn Durham City Centre"
        />
        <Input
          label="Postcode / ZIP"
          value={postcode}
          onChange={(e) => setPostcode(e.target.value)}
          placeholder="DH1 4DJ"
        />
        <Input
          label="Website"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />
        <Input
          label="Price range"
          value={priceRange}
          onChange={(e) => setPriceRange(e.target.value)}
          placeholder="£70–£120/night"
        />
      </div>
      <div className="flex justify-end">
        <Button variant="solid" onClick={handleAdd} disabled={submitting}>
          {submitting ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Geocoding…
            </>
          ) : (
            <>
              <PlusIcon className="w-4 h-4" />
              Add hotel
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortHotelsByProximity(
  hotels: NearbyHotel[],
  venueLat: number | null,
  venueLng: number | null,
): NearbyHotel[] {
  if (venueLat == null || venueLng == null) {
    return [...hotels].sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...hotels].sort((a, b) => {
    const da = distanceToVenue(a, venueLat, venueLng);
    const db = distanceToVenue(b, venueLat, venueLng);
    if (da == null && db == null) return a.name.localeCompare(b.name);
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });
}

function distanceToVenue(
  hotel: NearbyHotel,
  venueLat: number,
  venueLng: number,
): number | null {
  if (hotel.driveDistanceMeters != null) return hotel.driveDistanceMeters;
  if (hotel.lat == null || hotel.lng == null) return null;
  return haversineMeters({ lat: hotel.lat, lng: hotel.lng }, { lat: venueLat, lng: venueLng });
}

function formatHotelDistance(
  hotel: NearbyHotel,
  venueLat: number | null,
  venueLng: number | null,
): string | null {
  if (venueLat == null || venueLng == null) return null;
  const d = distanceToVenue(hotel, venueLat, venueLng);
  if (d == null) return null;
  return formatDistance(d);
}
