import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { PlusIcon, PencilIcon, TrashIcon, ArrowLeftIcon, VideoCameraIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal, Input } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, LiveSession, Cohort } from '@/lib/cohorts';

export default function CohortSessions() {
  const { cohortId, instructorId } = useParams<{ cohortId: string; instructorId: string }>();
  const navigate = useNavigate();
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingSession, setEditingSession] = useState<LiveSession | null>(null);
  const [formData, setFormData] = useState<Partial<LiveSession>>({
    cohort_id: cohortId,
    week_number: 1,
    session_title: '',
    session_date: '',
    zoom_link: '',
    recording_link: '',
  });

  useEffect(() => {
    if (cohortId) {
      loadCohort();
      loadSessions();
    }
  }, [cohortId]);

  const loadCohort = async () => {
    try {
      const { data: cohorts } = await CohortService.getCohorts();
      const foundCohort = cohorts.find(c => c.id === cohortId);
      if (foundCohort) {
        setCohort(foundCohort);
      }
    } catch (error: any) {
      console.error('Error loading cohort:', error);
      toast.error('Failed to load cohort');
    }
  };

  const loadSessions = async () => {
    if (!cohortId) return;
    setLoading(true);
    try {
      const { data, error } = await CohortService.getLiveSessions(cohortId);
      if (error) throw error;
      setSessions(data);
    } catch (error: any) {
      console.error('Error loading sessions:', error);
      toast.error('Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      if (editingSession) {
        const { error } = await CohortService.updateSession(editingSession.id, formData);
        if (error) throw error;
        toast.success('Session updated successfully');
      } else {
        const { error } = await CohortService.createSession({ ...formData, cohort_id: cohortId });
        if (error) throw error;
        toast.success('Session created successfully');
      }
      setShowModal(false);
      setEditingSession(null);
      resetForm();
      loadSessions();
    } catch (error: any) {
      console.error('Error saving session:', error);
      toast.error(error.message || 'Failed to save session');
    }
  };

  const handleEdit = (session: LiveSession) => {
    setEditingSession(session);
    // Format the date for the datetime-local input
    const formattedDate = new Date(session.session_date).toISOString().slice(0, 16);
    setFormData({ ...session, session_date: formattedDate });
    setShowModal(true);
  };

  const handleDelete = async (session: LiveSession) => {
    if (!confirm(`Are you sure you want to delete "${session.session_title}"?`)) return;

    try {
      const { error } = await CohortService.deleteSession(session.id);
      if (error) throw error;
      toast.success('Session deleted successfully');
      loadSessions();
    } catch (error: any) {
      console.error('Error deleting session:', error);
      toast.error('Failed to delete session');
    }
  };

  const resetForm = () => {
    setFormData({
      cohort_id: cohortId,
      week_number: 1,
      session_title: '',
      session_date: '',
      zoom_link: '',
      recording_link: '',
    });
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const isUpcoming = (dateString: string) => {
    return new Date(dateString) > new Date();
  };

  const upcomingSessions = sessions.filter(s => isUpcoming(s.session_date));
  const pastSessions = sessions.filter(s => !isUpcoming(s.session_date));

  return (
    <Page title={cohort ? `${cohort.title} - Live Sessions` : 'Live Sessions'}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/cohorts/instructors/${instructorId}`)}
              className="flex items-center gap-2"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back to Instructor
            </Button>
            <div>
              <h2 className="text-2xl font-bold">{cohort?.title}</h2>
              <p className="text-gray-600 dark:text-gray-400">
                Manage live sessions and recordings
              </p>
            </div>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              resetForm();
              setEditingSession(null);
              setShowModal(true);
            }}
            className="flex items-center gap-2"
          >
            <PlusIcon className="h-5 w-5" />
            Add Session
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="large" />
          </div>
        ) : (
          <>
            {/* Upcoming Sessions */}
            {upcomingSessions.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                  Upcoming Sessions
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {upcomingSessions.map((session) => (
                    <Card key={session.id} className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                            <VideoCameraIcon className="h-6 w-6 text-blue-600 dark:text-blue-300" />
                          </div>
                          <div>
                            <h4 className="font-semibold">{session.session_title}</h4>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              Week {session.week_number}
                            </p>
                          </div>
                        </div>
                        <Badge variant="success">Upcoming</Badge>
                      </div>

                      <div className="space-y-2 text-sm mb-4">
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">Date:</span>
                          <span className="font-medium">{formatDateTime(session.session_date)}</span>
                        </div>
                        {session.zoom_link && (
                          <div className="pt-2">
                            <a
                              href={session.zoom_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 dark:text-blue-400 hover:underline text-sm"
                            >
                              Join Zoom Meeting
                            </a>
                          </div>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleEdit(session)}
                          className="flex-1 flex items-center justify-center gap-1"
                        >
                          <PencilIcon className="h-4 w-4" />
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDelete(session)}
                          className="flex-1 flex items-center justify-center gap-1 text-red-600 hover:text-red-700"
                        >
                          <TrashIcon className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Past Sessions */}
            {pastSessions.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                  Past Sessions
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {pastSessions.map((session) => (
                    <Card key={session.id} className="p-6 opacity-75">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                            <VideoCameraIcon className="h-6 w-6 text-gray-600 dark:text-gray-400" />
                          </div>
                          <div>
                            <h4 className="font-semibold">{session.session_title}</h4>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              Week {session.week_number}
                            </p>
                          </div>
                        </div>
                        <Badge variant="secondary">Past</Badge>
                      </div>

                      <div className="space-y-2 text-sm mb-4">
                        <div className="flex justify-between">
                          <span className="text-gray-600 dark:text-gray-400">Date:</span>
                          <span className="font-medium">{formatDateTime(session.session_date)}</span>
                        </div>
                        {session.recording_link && (
                          <div className="pt-2">
                            <a
                              href={session.recording_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 dark:text-blue-400 hover:underline text-sm"
                            >
                              Watch Recording
                            </a>
                          </div>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleEdit(session)}
                          className="flex-1 flex items-center justify-center gap-1"
                        >
                          <PencilIcon className="h-4 w-4" />
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDelete(session)}
                          className="flex-1 flex items-center justify-center gap-1 text-red-600 hover:text-red-700"
                        >
                          <TrashIcon className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Empty State */}
            {sessions.length === 0 && (
              <Card className="p-12 text-center">
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  No sessions scheduled yet. Create your first session to get started.
                </p>
                <Button
                  variant="primary"
                  onClick={() => {
                    resetForm();
                    setEditingSession(null);
                    setShowModal(true);
                  }}
                >
                  <PlusIcon className="h-5 w-5 mr-2" />
                  Add First Session
                </Button>
              </Card>
            )}
          </>
        )}

        {/* Create/Edit Modal */}
        <Modal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingSession(null);
            resetForm();
          }}
          title={editingSession ? 'Edit Session' : 'Add New Session'}
          size="lg"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Week Number</label>
                <Input
                  type="number"
                  min="1"
                  max="12"
                  value={formData.week_number}
                  onChange={(e) => setFormData({ ...formData, week_number: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Session Date & Time</label>
                <Input
                  type="datetime-local"
                  value={formData.session_date}
                  onChange={(e) => setFormData({ ...formData, session_date: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Session Title</label>
              <Input
                value={formData.session_title}
                onChange={(e) => setFormData({ ...formData, session_title: e.target.value })}
                placeholder="Week 1 Kickoff Session"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Zoom Link</label>
              <Input
                type="url"
                value={formData.zoom_link || ''}
                onChange={(e) => setFormData({ ...formData, zoom_link: e.target.value })}
                placeholder="https://zoom.us/j/..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Recording Link (Optional)</label>
              <Input
                type="url"
                value={formData.recording_link || ''}
                onChange={(e) => setFormData({ ...formData, recording_link: e.target.value })}
                placeholder="https://..."
              />
              <p className="text-xs text-gray-500 mt-1">
                Add the recording link after the session is complete
              </p>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                variant="primary"
                onClick={handleSave}
                className="flex-1"
                disabled={!formData.session_title || !formData.session_date}
              >
                {editingSession ? 'Update Session' : 'Create Session'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowModal(false);
                  setEditingSession(null);
                  resetForm();
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
