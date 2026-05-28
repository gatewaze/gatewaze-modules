import { useState, useEffect } from 'react';
import { PersonProfile, winnerSelectionService } from '../utils/winnerSelectionService';
import { CompetitionWinnerService } from '../utils/competitionWinnerService';
import { Dialog } from '@headlessui/react';
import { XMarkIcon, ArrowPathIcon, EnvelopeIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface WinnerSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  customers: PersonProfile[];
  competitionTitle: string;
  onCyclingEmailChange: (email: string) => void;
  eventStart?: string;
  eventEnd?: string;
  offerTicketDetails?: string;
  preSelectedEmail?: string;
  eventId?: string;
  selectedEmails?: string[];
}

export default function WinnerSelectionModal({
  isOpen,
  onClose,
  customers,
  competitionTitle,
  onCyclingEmailChange,
  eventStart,
  eventEnd,
  offerTicketDetails,
  preSelectedEmail,
  eventId,
  selectedEmails = []
}: WinnerSelectionModalProps) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string>('');
  const [selectedWinner, setSelectedWinner] = useState<PersonProfile | null>(null);
  const [winnerDetails, setWinnerDetails] = useState<PersonProfile | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isLoggingWinner, setIsLoggingWinner] = useState(false);
  const [loggedSuccessfully, setLoggedSuccessfully] = useState(false);

  const selectWinner = async () => {
    if (customers.length === 0) return;

    setIsSelecting(true);
    setSelectedWinner(null);
    setWinnerDetails(null);
    setCurrentEmail('');

    // Dramatic cycling animation through email addresses
    let cycles = 0;
    const maxCycles = 50; // 5 seconds of cycling
    let speed = 200; // Start slower

    const runCycle = () => {
      const randomIndex = Math.floor(Math.random() * customers.length);
      const randomEmail = customers[randomIndex].email;
      setCurrentEmail(randomEmail);
      onCyclingEmailChange(randomEmail); // Update background highlighting
      cycles++;

      if (cycles >= maxCycles) {
        // Final selection
        const finalIndex = Math.floor(Math.random() * customers.length);
        const finalWinner = customers[finalIndex];

        setCurrentEmail(finalWinner.email);
        onCyclingEmailChange(finalWinner.email); // Keep final winner highlighted
        setSelectedWinner(finalWinner);

        console.log(`🏆 Winner selected: ${finalWinner.email}`);

        // Fetch full details for the winner
        setTimeout(async () => {
          setIsLoadingDetails(true);
          try {
            const fullDetails = await winnerSelectionService.getPersonDetails(finalWinner.cio_id);
            setWinnerDetails(fullDetails);
            console.log(`✅ Winner details loaded:`, fullDetails);
          } catch (error) {
            console.error('Error loading winner details:', error);
            setWinnerDetails(finalWinner); // Fallback to basic info
          } finally {
            setIsLoadingDetails(false);
            setIsSelecting(false);
          }
        }, 1500); // Wait 1.5 seconds before showing details

        return;
      }

      // Gradually speed up the cycling, then slow down at the end
      if (cycles < maxCycles * 0.3) {
        speed = Math.max(100, speed - 5); // Speed up initially
      } else if (cycles > maxCycles * 0.8) {
        speed = Math.min(300, speed + 10); // Slow down towards the end
      }

      setTimeout(runCycle, speed);
    };

    runCycle();
  };

  const handleClose = () => {
    if (!isSelecting) {
      setSelectedWinner(null);
      setWinnerDetails(null);
      setCurrentEmail('');
      setLoggedSuccessfully(false);
      onCyclingEmailChange(''); // Clear background highlighting
      onClose();
    }
  };

  const logWinnerToSupabase = async () => {
    if (!eventId) {
      console.warn('Cannot log winner: missing eventId');
      return;
    }

    // Check if multiple winners selected
    const isMultipleWinners = selectedWinner?.email === 'MULTIPLE_WINNERS';

    if (!isMultipleWinners && !selectedWinner) {
      console.warn('Cannot log winner: missing winner');
      return;
    }

    setIsLoggingWinner(true);
    try {
      if (isMultipleWinners) {
        // Log all selected winners
        const results = await Promise.all(
          selectedEmails.map(email =>
            CompetitionWinnerService.logWinner(email, eventId)
          )
        );

        const failedWinners = results.filter(r => !r.success);
        if (failedWinners.length > 0) {
          console.error('❌ Some winners failed to log:', failedWinners);
          alert(`Failed to log ${failedWinners.length} winner(s)`);
        } else {
          setLoggedSuccessfully(true);
          console.log(`✅ ${selectedEmails.length} winners logged successfully to Supabase`);
        }
      } else {
        // Log single winner
        const result = await CompetitionWinnerService.logWinner(selectedWinner!.email, eventId);

        if (result.success) {
          setLoggedSuccessfully(true);
          console.log('✅ Winner logged successfully to Supabase');
        } else {
          console.error('❌ Failed to log winner:', result.error);
          alert(`Failed to log winner: ${result.error}`);
        }
      }
    } catch (error) {
      console.error('❌ Unexpected error logging winner:', error);
      alert('Unexpected error occurred while logging winner');
    } finally {
      setIsLoggingWinner(false);
    }
  };

  const generateWinnerEmail = () => {
    if (!selectedWinner || !winnerDetails) return;

    const firstName = winnerDetails.first_name || 'there';
    const ticketType = offerTicketDetails || 'a free ticket';
    const subject = `You've won ${ticketType.toLowerCase().includes('ticket') ? ticketType.toLowerCase() : `a ${ticketType.toLowerCase()}`} to ${competitionTitle}`;

    // Format event date for inline use
    const getEventDateText = () => {
      if (!eventStart) return '';

      const startDate = new Date(eventStart);
      const endDate = eventEnd ? new Date(eventEnd) : null;

      const formatDate = (date: Date) => {
        return date.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric'
        });
      };

      if (endDate && eventStart !== eventEnd) {
        return ` on ${formatDate(startDate)} - ${formatDate(endDate)}`;
      } else {
        return ` on ${formatDate(startDate)}`;
      }
    };

    const body = `Hey ${firstName},

Congrats! You've won ${ticketType.toLowerCase().includes('ticket') ? ticketType.toLowerCase() : `a ${ticketType.toLowerCase()}`} to ${competitionTitle}${getEventDateText()}.

Just reply to this email to confirm that you're able to attend. Once we've got your confirmation, we'll get your pass sorted.

As some past competition prizes have gone unclaimed, we kindly ask that you respond by end of day tomorrow (${new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { weekday: 'long' })}). If we don't hear back by then, we may need to select a new winner.

Once everything is finalized, we'll announce it on our socials and tag you - feel free to share the news as well! If you post from the event, don't forget to tag us so we can reshare your posts!

Thanks again for entering!

Cheers
Dan`;

    const mailtoLink = `mailto:${selectedWinner.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    // Open with default mail client (should be Superhuman if set as default)
    window.open(mailtoLink);
  };

  // Start selection automatically when modal opens, or handle pre-selected winner
  useEffect(() => {
    if (isOpen && !isSelecting && !selectedWinner) {
      if (preSelectedEmail) {
        // Check if it's the multiple winners case
        if (preSelectedEmail === 'MULTIPLE_WINNERS') {
          // Show a generic "multiple winners selected" state without details
          setSelectedWinner({ email: 'MULTIPLE_WINNERS' } as PersonProfile);
          setWinnerDetails({ email: 'MULTIPLE_WINNERS' } as PersonProfile);
        } else {
          // If an email is pre-selected, skip the random selection and directly set the winner
          const preSelectedCustomer = customers.find(customer => customer.email === preSelectedEmail);
          if (preSelectedCustomer) {
            setCurrentEmail(preSelectedEmail);
            onCyclingEmailChange(preSelectedEmail);
            setSelectedWinner(preSelectedCustomer);

            // Load details for the pre-selected winner
            setTimeout(async () => {
              setIsLoadingDetails(true);
              try {
                const fullDetails = await winnerSelectionService.getPersonDetails(preSelectedCustomer.cio_id);
                setWinnerDetails(fullDetails);
              } catch (error) {
                console.error('Error loading winner details:', error);
                setWinnerDetails(preSelectedCustomer); // Fallback to basic info
              } finally {
                setIsLoadingDetails(false);
              }
            }, 500);
          }
        }
      } else {
        // Normal random selection
        setTimeout(selectWinner, 500); // Small delay for dramatic effect
      }
    }
  }, [isOpen, preSelectedEmail]);

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" aria-hidden="true" />

      {/* Full-screen container to center the panel */}
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-3xl w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
            <div>
              <Dialog.Title className="text-xl font-semibold text-neutral-900 dark:text-white">
                Winner Selection
              </Dialog.Title>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                {competitionTitle}
              </p>
            </div>
            {!isSelecting && (
              <button
                onClick={handleClose}
                className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                <XMarkIcon className="size-6" />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="p-6">
            {isSelecting ? (
              <div className="text-center py-12">
                <div className="mb-6">
                  <LoadingSpinner size="large" className="mx-auto" />
                </div>
                <div className="text-2xl font-mono text-neutral-900 dark:text-white mb-4">
                  {currentEmail || 'Preparing selection...'}
                </div>
                <p className="text-neutral-600 dark:text-neutral-400">
                  Selecting random winner from {customers.length} entries...
                </p>
              </div>
            ) : selectedWinner ? (
              <div className="space-y-6">
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-green-600 dark:text-green-400 mb-4">
                    🏆 Winner Selected
                  </h3>
                  {selectedWinner.email === 'MULTIPLE_WINNERS' ? (
                    <div className="text-lg text-neutral-900 dark:text-white bg-neutral-100 dark:bg-neutral-900 p-4 rounded-lg">
                      Multiple winners selected
                    </div>
                  ) : (
                    <div className="text-2xl font-mono text-neutral-900 dark:text-white bg-neutral-100 dark:bg-neutral-900 p-4 rounded-lg">
                      {selectedWinner.email}
                    </div>
                  )}
                </div>

                {isLoadingDetails ? (
                  <div className="text-center py-8">
                    <LoadingSpinner size="medium" className="mx-auto mb-3" />
                    <p className="text-neutral-600 dark:text-neutral-400">Loading winner details...</p>
                  </div>
                ) : winnerDetails && winnerDetails.email !== 'MULTIPLE_WINNERS' ? (
                  <div className="bg-neutral-50 dark:bg-neutral-900 rounded-lg p-4 space-y-3">
                    {(winnerDetails.first_name || winnerDetails.last_name) && (
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Name:</span>
                        <span className="text-sm text-neutral-900 dark:text-white">
                          {`${winnerDetails.first_name || ''} ${winnerDetails.last_name || ''}`.trim()}
                        </span>
                      </div>
                    )}
                    {winnerDetails.company && (
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Company:</span>
                        <span className="text-sm text-neutral-900 dark:text-white">{winnerDetails.company}</span>
                      </div>
                    )}
                    {winnerDetails.job_title && (
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Job Title:</span>
                        <span className="text-sm text-neutral-900 dark:text-white">{winnerDetails.job_title}</span>
                      </div>
                    )}
                    {winnerDetails.city && (
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Location:</span>
                        <span className="text-sm text-neutral-900 dark:text-white">
                          {winnerDetails.city}{winnerDetails.country ? `, ${winnerDetails.country}` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-3 pt-4">
                  {winnerDetails && winnerDetails.email !== 'MULTIPLE_WINNERS' && (
                    <button
                      onClick={generateWinnerEmail}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-medium transition-colors"
                    >
                      <EnvelopeIcon className="size-5" />
                      Email
                    </button>
                  )}
                  {winnerDetails && eventId && (
                    <button
                      onClick={logWinnerToSupabase}
                      disabled={isLoggingWinner || loggedSuccessfully}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                        loggedSuccessfully
                          ? 'bg-green-600 text-white cursor-default'
                          : 'bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50 disabled:cursor-not-allowed'
                      }`}
                    >
                      {isLoggingWinner ? (
                        <>
                          <LoadingSpinner size="sm" />
                          Accepting...
                        </>
                      ) : loggedSuccessfully ? (
                        <>
                          <CheckCircleIcon className="size-5" />
                          Accepted
                        </>
                      ) : (
                        <>
                          <CheckCircleIcon className="size-5" />
                          Accept Winner{winnerDetails.email === 'MULTIPLE_WINNERS' && selectedEmails.length > 1 ? 's' : ''}
                        </>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => selectWinner()}
                    disabled={isSelecting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                  >
                    <ArrowPathIcon className="size-5" />
                    Select Another
                  </button>
                  <button
                    onClick={handleClose}
                    className="px-6 py-2 bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600 text-neutral-900 dark:text-white rounded-lg font-medium transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <LoadingSpinner size="large" className="mx-auto mb-3" />
                <p className="text-neutral-600 dark:text-neutral-400">Preparing winner selection...</p>
              </div>
            )}
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
