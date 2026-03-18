import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  PlusIcon,
  TrashIcon,
  PencilIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  VideoCameraIcon,
  CodeBracketIcon,
  PresentationChartBarIcon,
  LinkIcon,
  ChatBubbleLeftRightIcon,
  ComputerDesktopIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Input, Modal } from '@/components/ui';
import { Cohort, CohortWeek, CohortModule, CohortResource, LiveSession } from '@/lib/cohorts/types';
import { supabase } from '@/lib/supabase';
import { TimezoneSelector } from '@/components/events/TimezoneSelector';

// Helper function to get icon for resource type
const getResourceIcon = (resourceType: string) => {
  switch (resourceType.toLowerCase()) {
    case 'article':
    case 'document':
      return DocumentTextIcon;
    case 'video':
      return VideoCameraIcon;
    case 'code':
      return CodeBracketIcon;
    case 'slides':
    case 'presentation':
      return PresentationChartBarIcon;
    case 'slack':
      return ChatBubbleLeftRightIcon;
    case 'zoom':
      return ComputerDesktopIcon;
    case 'link':
    case 'url':
      return LinkIcon;
    default:
      return LinkIcon;
  }
};

interface CohortWeeksTabProps {
  cohort: Cohort;
}

export function CohortWeeksTab({ cohort }: CohortWeeksTabProps) {
  const [weeks, setWeeks] = useState<CohortWeek[]>([]);
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  const [showWeekModal, setShowWeekModal] = useState(false);
  const [editingWeek, setEditingWeek] = useState<CohortWeek | null>(null);
  const [weekFormData, setWeekFormData] = useState({
    week_number: 1,
    title: '',
    description: '',
    start_date: '',
    end_date: '',
  });

  useEffect(() => {
    loadWeeks();
  }, [cohort.id]);

  const loadWeeks = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_weeks')
        .select('*')
        .eq('cohort_id', cohort.id)
        .order('week_number', { ascending: true });

      if (error) throw error;
      setWeeks(data || []);
    } catch (error: any) {
      console.error('Error loading weeks:', error);
      toast.error('Failed to load weeks');
    }
  };

  const handleCreateWeek = () => {
    const nextWeekNumber = weeks.length > 0 ? Math.max(...weeks.map(w => w.week_number)) + 1 : 1;
    setWeekFormData({
      week_number: nextWeekNumber,
      title: '',
      description: '',
      start_date: '',
      end_date: '',
    });
    setEditingWeek(null);
    setShowWeekModal(true);
  };

  const handleEditWeek = (week: CohortWeek) => {
    setWeekFormData({
      week_number: week.week_number,
      title: week.title,
      description: week.description || '',
      start_date: week.start_date || '',
      end_date: week.end_date || '',
    });
    setEditingWeek(week);
    setShowWeekModal(true);
  };

  const handleSaveWeek = async () => {
    try {
      // Convert empty strings to null for date fields
      const dataToSave = {
        ...weekFormData,
        start_date: weekFormData.start_date || null,
        end_date: weekFormData.end_date || null,
      };

      if (editingWeek) {
        const { error } = await supabase
          .from('cohorts_weeks')
          .update(dataToSave)
          .eq('id', editingWeek.id);

        if (error) throw error;
        toast.success('Week updated successfully');
      } else {
        const { error } = await supabase
          .from('cohorts_weeks')
          .insert([{ ...dataToSave, cohort_id: cohort.id }]);

        if (error) throw error;
        toast.success('Week created successfully');
      }

      setShowWeekModal(false);
      loadWeeks();
    } catch (error: any) {
      console.error('Error saving week:', error);
      toast.error(error.message || 'Failed to save week');
    }
  };

  const handleDeleteWeek = async (weekId: string) => {
    if (!confirm('Are you sure you want to delete this week? This will also delete all modules, resources, and sessions associated with it.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('cohorts_weeks')
        .delete()
        .eq('id', weekId);

      if (error) throw error;
      toast.success('Week deleted successfully');
      loadWeeks();
    } catch (error: any) {
      console.error('Error deleting week:', error);
      toast.error('Failed to delete week');
    }
  };

  const toggleWeekExpansion = (weekId: string) => {
    const newExpanded = new Set(expandedWeeks);
    if (newExpanded.has(weekId)) {
      newExpanded.delete(weekId);
    } else {
      newExpanded.add(weekId);
    }
    setExpandedWeeks(newExpanded);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Cohort Weeks
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Organize your cohort into weeks, then add modules, resources, and sessions to each week
          </p>
        </div>
        <Button variant="primary" onClick={handleCreateWeek}>
          <PlusIcon className="h-5 w-5 mr-2" />
          Add Week
        </Button>
      </div>

      {weeks.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            No weeks created yet. Create your first week to start organizing your cohort content.
          </p>
          <Button variant="primary" onClick={handleCreateWeek}>
            <PlusIcon className="h-5 w-5 mr-2" />
            Create First Week
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {weeks.map((week) => (
            <WeekCard
              key={week.id}
              week={week}
              cohortId={cohort.id}
              isExpanded={expandedWeeks.has(week.id)}
              onToggle={() => toggleWeekExpansion(week.id)}
              onEdit={() => handleEditWeek(week)}
              onDelete={() => handleDeleteWeek(week.id)}
            />
          ))}
        </div>
      )}

      <Modal
        isOpen={showWeekModal}
        onClose={() => setShowWeekModal(false)}
        title={editingWeek ? 'Edit Week' : 'Create New Week'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Week Number</label>
            <Input
              type="number"
              value={weekFormData.week_number}
              onChange={(e) => setWeekFormData({ ...weekFormData, week_number: parseInt(e.target.value) })}
              min="1"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <Input
              value={weekFormData.title}
              onChange={(e) => setWeekFormData({ ...weekFormData, title: e.target.value })}
              placeholder="Introduction to Machine Learning"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={weekFormData.description}
              onChange={(e) => setWeekFormData({ ...weekFormData, description: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
              rows={3}
              placeholder="What topics will be covered this week?"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Start Date (Optional)</label>
              <Input
                type="date"
                value={weekFormData.start_date}
                onChange={(e) => setWeekFormData({ ...weekFormData, start_date: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">End Date (Optional)</label>
              <Input
                type="date"
                value={weekFormData.end_date}
                onChange={(e) => setWeekFormData({ ...weekFormData, end_date: e.target.value })}
              />
            </div>
          </div>

          <div className="flex gap-3 pt-4">
            <Button
              variant="primary"
              onClick={handleSaveWeek}
              className="flex-1"
              disabled={!weekFormData.title}
            >
              {editingWeek ? 'Update Week' : 'Create Week'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowWeekModal(false)}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface WeekCardProps {
  week: CohortWeek;
  cohortId: string;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function WeekCard({ week, cohortId, isExpanded, onToggle, onEdit, onDelete }: WeekCardProps) {
  const [modules, setModules] = useState<CohortModule[]>([]);
  const [expandedModules, setExpandedModules] = useState<Set<number>>(new Set());
  const [showModuleModal, setShowModuleModal] = useState(false);
  const [editingModule, setEditingModule] = useState<CohortModule | null>(null);
  const [moduleFormData, setModuleFormData] = useState({
    title: '',
    description: '',
    topics: [] as string[],
    module_order: 1,
  });

  useEffect(() => {
    if (isExpanded) {
      loadModules();
    }
  }, [isExpanded, week.id]);

  const loadModules = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_modules')
        .select('*')
        .eq('cohort_week_id', week.id)
        .order('module_order', { ascending: true});

      if (error) throw error;
      setModules(data || []);
    } catch (error: any) {
      console.error('Error loading modules:', error);
    }
  };

  const handleCreateModule = () => {
    const nextOrder = modules.length > 0 ? Math.max(...modules.map(m => m.module_order)) + 1 : 1;
    setModuleFormData({
      title: '',
      description: '',
      topics: [],
      module_order: nextOrder,
    });
    setEditingModule(null);
    setShowModuleModal(true);
  };

  const handleEditModule = (module: CohortModule) => {
    setModuleFormData({
      title: module.title,
      description: module.description,
      topics: module.topics || [],
      module_order: module.module_order,
    });
    setEditingModule(module);
    setShowModuleModal(true);
  };

  const handleSaveModule = async () => {
    try {
      // Ensure topics is not empty (DB constraint)
      const topicsToSave = moduleFormData.topics.length > 0 ? moduleFormData.topics : ['General'];

      if (editingModule) {
        const { error } = await supabase
          .from('cohorts_modules')
          .update({ ...moduleFormData, topics: topicsToSave })
          .eq('id', editingModule.id);

        if (error) throw error;
        toast.success('Module updated successfully');
      } else {
        const { error } = await supabase
          .from('cohorts_modules')
          .insert([{
            ...moduleFormData,
            topics: topicsToSave,
            cohort_id: cohortId,
            cohort_week_id: week.id,
            week: week.week_number, // For backward compatibility
          }]);

        if (error) throw error;
        toast.success('Module created successfully');
      }

      setShowModuleModal(false);
      loadModules();
    } catch (error: any) {
      console.error('Error saving module:', error);
      toast.error(error.message || 'Failed to save module');
    }
  };

  const handleDeleteModule = async (moduleId: number) => {
    if (!confirm('Are you sure you want to delete this module? This will also delete all resources and sessions associated with it.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('cohorts_modules')
        .delete()
        .eq('id', moduleId);

      if (error) throw error;
      toast.success('Module deleted successfully');
      loadModules();
    } catch (error: any) {
      console.error('Error deleting module:', error);
      toast.error('Failed to delete module');
    }
  };

  const toggleModuleExpansion = (moduleId: number) => {
    const newExpanded = new Set(expandedModules);
    if (newExpanded.has(moduleId)) {
      newExpanded.delete(moduleId);
    } else {
      newExpanded.add(moduleId);
    }
    setExpandedModules(newExpanded);
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <Card className="overflow-hidden">
      {/* Week Header */}
      <div className="p-4 bg-gray-50 dark:bg-gray-800/50">
        <div className="flex items-center justify-between">
          <button
            onClick={onToggle}
            className="flex items-center gap-3 flex-1 text-left"
          >
            {isExpanded ? (
              <ChevronDownIcon className="h-5 w-5 text-gray-500" />
            ) : (
              <ChevronRightIcon className="h-5 w-5 text-gray-500" />
            )}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Week {week.week_number}: {week.title}
              </h3>
              {(week.start_date || week.end_date) && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {formatDate(week.start_date)} {week.end_date && `- ${formatDate(week.end_date)}`}
                </p>
              )}
            </div>
          </button>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <PencilIcon className="h-4 w-4" />
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              <TrashIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {week.description && (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 ml-8">
            {week.description}
          </p>
        )}
      </div>

      {/* Week Content (Modules) */}
      {isExpanded && (
        <div className="p-4 border-t dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-semibold text-gray-900 dark:text-white">Modules</h4>
            <Button variant="primary" size="sm" onClick={handleCreateModule}>
              <PlusIcon className="h-4 w-4 mr-2" />
              Add Module
            </Button>
          </div>

          {modules.length === 0 ? (
            <p className="text-gray-600 dark:text-gray-400 text-center py-4">
              No modules added to this week yet
            </p>
          ) : (
            <div className="space-y-3">
              {modules.map((module) => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  isExpanded={expandedModules.has(module.id)}
                  onToggle={() => toggleModuleExpansion(module.id)}
                  onEdit={() => handleEditModule(module)}
                  onDelete={() => handleDeleteModule(module.id)}
                />
              ))}
            </div>
          )}

          {/* Module Modal */}
          <Modal
            isOpen={showModuleModal}
            onClose={() => setShowModuleModal(false)}
            title={editingModule ? 'Edit Module' : 'Create New Module'}
            size="lg"
          >
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Module Order</label>
                <Input
                  type="number"
                  value={moduleFormData.module_order}
                  onChange={(e) => setModuleFormData({ ...moduleFormData, module_order: parseInt(e.target.value) })}
                  min="1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <Input
                  value={moduleFormData.title}
                  onChange={(e) => setModuleFormData({ ...moduleFormData, title: e.target.value })}
                  placeholder="Neural Networks Fundamentals"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={moduleFormData.description}
                  onChange={(e) => setModuleFormData({ ...moduleFormData, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  rows={3}
                  placeholder="What will students learn in this module?"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Topics (comma-separated)</label>
                <Input
                  value={moduleFormData.topics.join(', ')}
                  onChange={(e) => setModuleFormData({
                    ...moduleFormData,
                    topics: e.target.value.split(',').map(t => t.trim()).filter(t => t)
                  })}
                  placeholder="Backpropagation, Activation Functions, Gradient Descent"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <Button
                  variant="primary"
                  onClick={handleSaveModule}
                  className="flex-1"
                  disabled={!moduleFormData.title || !moduleFormData.description}
                >
                  {editingModule ? 'Update Module' : 'Create Module'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowModuleModal(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </Card>
  );
}

interface ModuleCardProps {
  module: CohortModule;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ModuleCard({ module, isExpanded, onToggle, onEdit, onDelete }: ModuleCardProps) {
  const [resources, setResources] = useState<CohortResource[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [showResourceModal, setShowResourceModal] = useState(false);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [editingResource, setEditingResource] = useState<CohortResource | null>(null);
  const [editingSession, setEditingSession] = useState<LiveSession | null>(null);
  const [resourceFormData, setResourceFormData] = useState({
    title: '',
    description: '',
    resource_type: 'article',
    resource_url: '',
    is_member_only: false,
  });
  const [sessionFormData, setSessionFormData] = useState({
    session_title: '',
    session_date: '',
    zoom_link: '',
    recording_link: '',
  });

  useEffect(() => {
    if (isExpanded) {
      loadResources();
      loadSessions();
    }
  }, [isExpanded, module.id]);

  const loadResources = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_resources')
        .select('*')
        .eq('module_id', module.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setResources(data || []);
    } catch (error: any) {
      console.error('Error loading resources:', error);
    }
  };

  const loadSessions = async () => {
    try {
      const { data, error } = await supabase
        .from('cohorts_live_sessions')
        .select('*')
        .eq('module_id', module.id)
        .order('session_date', { ascending: true });

      if (error) throw error;
      setSessions(data || []);
    } catch (error: any) {
      console.error('Error loading sessions:', error);
    }
  };

  // Resource handlers
  const handleAddResource = () => {
    setEditingResource(null);
    setResourceFormData({
      title: '',
      description: '',
      resource_type: 'article',
      resource_url: '',
      is_member_only: false,
    });
    setShowResourceModal(true);
  };

  const handleEditResource = (resource: CohortResource) => {
    setEditingResource(resource);
    setResourceFormData({
      title: resource.title,
      description: resource.description || '',
      resource_type: resource.resource_type,
      resource_url: resource.resource_url,
      is_member_only: resource.is_member_only,
    });
    setShowResourceModal(true);
  };

  const handleSaveResource = async () => {
    try {
      if (editingResource) {
        const { error } = await supabase
          .from('cohorts_resources')
          .update(resourceFormData)
          .eq('id', editingResource.id);
        if (error) throw error;
        toast.success('Resource updated');
      } else {
        const { error } = await supabase
          .from('cohorts_resources')
          .insert([{
            ...resourceFormData,
            cohort_id: module.cohort_id,
            module_id: module.id,
            week_number: module.week,
          }]);
        if (error) throw error;
        toast.success('Resource added');
      }
      setShowResourceModal(false);
      loadResources();
    } catch (error: any) {
      console.error('Error saving resource:', error);
      toast.error('Failed to save resource');
    }
  };

  const handleDeleteResource = async (resourceId: string) => {
    if (!confirm('Are you sure you want to delete this resource?')) return;

    try {
      const { error } = await supabase
        .from('cohorts_resources')
        .delete()
        .eq('id', resourceId);
      if (error) throw error;
      toast.success('Resource deleted');
      loadResources();
    } catch (error: any) {
      console.error('Error deleting resource:', error);
      toast.error('Failed to delete resource');
    }
  };

  // Session handlers
  const handleAddSession = () => {
    setEditingSession(null);
    setSessionFormData({
      session_title: '',
      session_date: '',
      session_end_date: '',
      timezone: 'UTC',
      zoom_link: '',
      recording_link: '',
    });
    setShowSessionModal(true);
  };

  const handleEditSession = (session: LiveSession) => {
    setEditingSession(session);
    setSessionFormData({
      session_title: session.session_title,
      session_date: session.session_date ? session.session_date.slice(0, 16) : '',
      session_end_date: session.session_end_date ? session.session_end_date.slice(0, 16) : '',
      timezone: session.timezone || 'UTC',
      zoom_link: session.zoom_link || '',
      recording_link: session.recording_link || '',
    });
    setShowSessionModal(true);
  };

  const handleSaveSession = async () => {
    try {
      const dataToSave = {
        ...sessionFormData,
        session_date: sessionFormData.session_date || null,
        session_end_date: sessionFormData.session_end_date || null,
      };

      if (editingSession) {
        const { error } = await supabase
          .from('cohorts_live_sessions')
          .update(dataToSave)
          .eq('id', editingSession.id);
        if (error) throw error;
        toast.success('Session updated');
      } else {
        const { error } = await supabase
          .from('cohorts_live_sessions')
          .insert([{
            ...dataToSave,
            cohort_id: module.cohort_id,
            module_id: module.id,
            week_number: module.week,
          }]);
        if (error) throw error;
        toast.success('Session added');
      }
      setShowSessionModal(false);
      loadSessions();
    } catch (error: any) {
      console.error('Error saving session:', error);
      toast.error('Failed to save session');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
      const { error } = await supabase
        .from('cohorts_live_sessions')
        .delete()
        .eq('id', sessionId);
      if (error) throw error;
      toast.success('Session deleted');
      loadSessions();
    } catch (error: any) {
      console.error('Error deleting session:', error);
      toast.error('Failed to delete session');
    }
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden">
      <div className="p-3">
        <div className="flex items-center justify-between">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 flex-1 text-left"
          >
            {isExpanded ? (
              <ChevronDownIcon className="h-4 w-4 text-gray-500" />
            ) : (
              <ChevronRightIcon className="h-4 w-4 text-gray-500" />
            )}
            <div>
              <h5 className="font-medium text-gray-900 dark:text-white">
                Module {module.module_order}: {module.title}
              </h5>
              {module.topics && module.topics.length > 0 && (
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                  Topics: {module.topics.join(', ')}
                </p>
              )}
            </div>
          </button>

          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <PencilIcon className="h-3 w-3" />
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              <TrashIcon className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {module.description && !isExpanded && (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 ml-6 line-clamp-2">
            {module.description}
          </p>
        )}
      </div>

      {isExpanded && (
        <div className="p-3 pt-0 ml-6 space-y-3">
          {module.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {module.description}
            </p>
          )}

          {/* Resources */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <DocumentTextIcon className="h-4 w-4" />
                <span>Resources ({resources.length})</span>
              </div>
              <Button variant="primary" size="sm" onClick={handleAddResource}>
                <PlusIcon className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
            {resources.length > 0 ? (
              <div className="space-y-2 ml-6">
                {resources.map((resource) => {
                  const ResourceIcon = getResourceIcon(resource.resource_type);
                  return (
                    <div key={resource.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-900 rounded">
                      <div className="flex items-center gap-2 flex-1">
                        <ResourceIcon className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{resource.title}</p>
                          <p className="text-xs text-gray-500 capitalize">{resource.resource_type}</p>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEditResource(resource)}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                        >
                          <PencilIcon className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                        </button>
                        <button
                          onClick={() => handleDeleteResource(resource.id)}
                          className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded"
                        >
                          <TrashIcon className="h-3 w-3 text-red-600 dark:text-red-400" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-500 ml-6">No resources yet</p>
            )}
          </div>

          {/* Live Sessions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <VideoCameraIcon className="h-4 w-4" />
                <span>Live Sessions ({sessions.length})</span>
              </div>
              <Button variant="primary" size="sm" onClick={handleAddSession}>
                <PlusIcon className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
            {sessions.length > 0 ? (
              <div className="space-y-2 ml-6">
                {sessions.map((session) => (
                  <div key={session.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-900 rounded">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{session.session_title}</p>
                      {session.session_date && (
                        <p className="text-xs text-gray-500">
                          {new Date(session.session_date).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEditSession(session)}
                        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                      >
                        <PencilIcon className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                      </button>
                      <button
                        onClick={() => handleDeleteSession(session.id)}
                        className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded"
                      >
                        <TrashIcon className="h-3 w-3 text-red-600 dark:text-red-400" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-500 ml-6">No sessions yet</p>
            )}
          </div>
        </div>
      )}

      {/* Resource Modal */}
      <Modal
        isOpen={showResourceModal}
        onClose={() => setShowResourceModal(false)}
        title={editingResource ? 'Edit Resource' : 'Add Resource'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <Input
              value={resourceFormData.title}
              onChange={(e) => setResourceFormData({ ...resourceFormData, title: e.target.value })}
              placeholder="Resource title"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={resourceFormData.description}
              onChange={(e) => setResourceFormData({ ...resourceFormData, description: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
              rows={3}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select
              value={resourceFormData.resource_type}
              onChange={(e) => setResourceFormData({ ...resourceFormData, resource_type: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
            >
              <option value="article">Article</option>
              <option value="document">Document</option>
              <option value="video">Video</option>
              <option value="code">Code</option>
              <option value="slides">Slides</option>
              <option value="slack">Slack</option>
              <option value="zoom">Zoom</option>
              <option value="link">Link</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <Input
              value={resourceFormData.resource_url}
              onChange={(e) => setResourceFormData({ ...resourceFormData, resource_url: e.target.value })}
              placeholder="https://..."
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={resourceFormData.is_member_only}
              onChange={(e) => setResourceFormData({ ...resourceFormData, is_member_only: e.target.checked })}
              className="rounded"
            />
            <label className="text-sm">Member only</label>
          </div>
          <div className="flex gap-3 pt-4">
            <Button variant="primary" onClick={handleSaveResource} className="flex-1">
              {editingResource ? 'Update' : 'Add'}
            </Button>
            <Button variant="secondary" onClick={() => setShowResourceModal(false)} className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Session Modal */}
      <Modal
        isOpen={showSessionModal}
        onClose={() => setShowSessionModal(false)}
        title={editingSession ? 'Edit Session' : 'Add Session'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <Input
              value={sessionFormData.session_title}
              onChange={(e) => setSessionFormData({ ...sessionFormData, session_title: e.target.value })}
              placeholder="Session title"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Start Date & Time</label>
            <Input
              type="datetime-local"
              value={sessionFormData.session_date}
              onChange={(e) => setSessionFormData({ ...sessionFormData, session_date: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">End Date & Time</label>
            <Input
              type="datetime-local"
              value={sessionFormData.session_end_date}
              onChange={(e) => setSessionFormData({ ...sessionFormData, session_end_date: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Timezone</label>
            <TimezoneSelector
              value={sessionFormData.timezone || 'UTC'}
              onChange={(value) => setSessionFormData({ ...sessionFormData, timezone: value })}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Session location timezone. Times are stored in UTC.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Zoom Link</label>
            <Input
              value={sessionFormData.zoom_link}
              onChange={(e) => setSessionFormData({ ...sessionFormData, zoom_link: e.target.value })}
              placeholder="https://zoom.us/..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Recording Link (Optional)</label>
            <Input
              value={sessionFormData.recording_link}
              onChange={(e) => setSessionFormData({ ...sessionFormData, recording_link: e.target.value })}
              placeholder="https://..."
            />
          </div>
          <div className="flex gap-3 pt-4">
            <Button variant="primary" onClick={handleSaveSession} className="flex-1">
              {editingSession ? 'Update' : 'Add'}
            </Button>
            <Button variant="secondary" onClick={() => setShowSessionModal(false)} className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
