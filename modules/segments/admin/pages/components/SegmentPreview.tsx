import React, { useEffect, useState } from 'react';
import { UserGroupIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Card, Badge, Avatar } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';
import { createSegmentService, isValidSegmentDefinition } from '@/lib/segments';
import type { SegmentDefinition, SegmentMember } from '@/lib/segments';
import { useDebounceValue } from '@/hooks';

interface SegmentPreviewProps {
  definition: SegmentDefinition;
  debounceMs?: number;
}

export function SegmentPreview({ definition, debounceMs = 800 }: SegmentPreviewProps) {
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<SegmentMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isEstimate, setIsEstimate] = useState(false);

  // Debounce definition changes
  const [debouncedDefinition] = useDebounceValue(definition, debounceMs);

  useEffect(() => {
    const fetchPreview = async () => {
      // Skip if definition is incomplete
      if (!isValidSegmentDefinition(debouncedDefinition)) {
        setCount(null);
        setSample([]);
        setError(null);
        setIsEstimate(false);
        return;
      }

      if (!supabase) {
        setError('Database connection not available');
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const segmentService = createSegmentService(supabase);
        const result = await segmentService.previewSegment(debouncedDefinition);
        setCount(result.count);
        setSample(result.sample);
        setIsEstimate(result.isEstimate || false);
      } catch (err) {
        console.error('Preview error:', err);
        // Handle timeout specifically
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes('timeout') || errorMessage.includes('57014')) {
          setError('Preview timed out. The segment will still work when saved.');
        } else {
          setError(errorMessage || 'Failed to generate preview');
        }
        setCount(null);
        setSample([]);
        setIsEstimate(false);
      } finally {
        setLoading(false);
      }
    };

    fetchPreview();
  }, [debouncedDefinition]);

  const isValid = isValidSegmentDefinition(definition);

  return (
    <Card
      skin="bordered"
      className={`p-5 transition-all duration-300 ${
        error
          ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
          : isValid
            ? 'bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border-blue-200 dark:border-blue-800'
            : 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div
            className={`p-2 rounded-lg ${
              error
                ? 'bg-red-100 dark:bg-red-900/30'
                : 'bg-blue-100 dark:bg-blue-900/30'
            }`}
          >
            {error ? (
              <ExclamationTriangleIcon className="size-5 text-red-600 dark:text-red-400" />
            ) : (
              <UserGroupIcon className="size-5 text-blue-600 dark:text-blue-400" />
            )}
          </div>
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            Live Preview
          </span>
        </div>
        {loading && <Spinner className="size-5" />}
      </div>

      {error ? (
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      ) : !isValid ? (
        <div className="text-gray-500 dark:text-gray-400 text-sm">
          Complete your segment conditions to see a preview of matching customers.
        </div>
      ) : count !== null ? (
        <div className="space-y-4">
          {/* Count Display */}
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-bold text-blue-700 dark:text-blue-300 tabular-nums">
              {isEstimate ? `${count.toLocaleString()}+` : count.toLocaleString()}
            </span>
            <span className="text-sm text-blue-600 dark:text-blue-400">
              {count === 1 ? 'customer matches' : 'customers match'} this segment
              {isEstimate && ' (estimate)'}
            </span>
          </div>

          {/* Sample Members */}
          {sample.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                  Sample members
                </span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
              </div>
              <div className="flex flex-wrap gap-2">
                {sample.slice(0, 8).map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-2 bg-white dark:bg-gray-800 px-3 py-2 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700"
                  >
                    <Avatar
                      name={
                        member.attributes?.first_name && member.attributes?.last_name
                          ? `${member.attributes.first_name} ${member.attributes.last_name}`
                          : member.email
                      }
                      size={7}
                      initialColor="auto"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[150px]">
                        {member.attributes?.first_name
                          ? `${member.attributes.first_name} ${member.attributes.last_name || ''}`
                          : member.email}
                      </div>
                      {member.attributes?.company && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[150px]">
                          {member.attributes.company}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {sample.length > 8 && (
                  <Badge
                    variant="soft"
                    color="info"
                    className="self-center"
                  >
                    +{sample.length - 8} more
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Empty State */}
          {count === 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400 bg-white/50 dark:bg-gray-800/50 rounded-lg p-3">
              No customers match these conditions. Try adjusting your criteria.
            </div>
          )}
        </div>
      ) : (
        <div className="text-gray-500 dark:text-gray-400 text-sm">
          Calculating...
        </div>
      )}
    </Card>
  );
}
