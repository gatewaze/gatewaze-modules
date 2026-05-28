import { useState, useEffect } from 'react';
import {
  CheckCircleIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Card, Input } from '@/components/ui';
import { supabase } from '@/lib/supabase';

interface WhatsAppConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  WHATSAPP_FROM_NUMBER: string;
}

const EMPTY_CONFIG: WhatsAppConfig = {
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  WHATSAPP_FROM_NUMBER: '',
};

export default function WhatsAppSettings() {
  const [config, setConfig] = useState<WhatsAppConfig>(EMPTY_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testNumber, setTestNumber] = useState('');

  // Fetch existing config
  useEffect(() => {
    async function fetchConfig() {
      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from('installed_modules')
          .select('config')
          .eq('id', 'whatsapp')
          .single();

        if (error) throw error;

        if (data?.config) {
          const saved = data.config as Record<string, string>;
          setConfig({
            TWILIO_ACCOUNT_SID: saved.TWILIO_ACCOUNT_SID || '',
            TWILIO_AUTH_TOKEN: saved.TWILIO_AUTH_TOKEN || '',
            WHATSAPP_FROM_NUMBER: saved.WHATSAPP_FROM_NUMBER || '',
          });
          setHasExisting(true);
        }
      } catch (err) {
        console.error('Failed to load WhatsApp config:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchConfig();
  }, []);

  const handleSave = async () => {
    if (!config.TWILIO_ACCOUNT_SID.trim()) {
      toast.error('Account SID is required');
      return;
    }
    if (!config.TWILIO_AUTH_TOKEN.trim()) {
      toast.error('Auth Token is required');
      return;
    }
    if (!config.WHATSAPP_FROM_NUMBER.trim()) {
      toast.error('WhatsApp From Number is required');
      return;
    }

    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(config.WHATSAPP_FROM_NUMBER.trim())) {
      toast.error('From Number must be in E.164 format (e.g. +14155238886)');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('installed_modules')
        .update({ config })
        .eq('id', 'whatsapp');

      if (error) throw error;

      toast.success('WhatsApp settings saved');
      setHasExisting(true);
    } catch (err) {
      console.error('Failed to save WhatsApp config:', err);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestSend = async () => {
    if (!testNumber.trim()) {
      toast.error('Enter a phone number to send a test message');
      return;
    }

    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(testNumber.trim())) {
      toast.error('Test number must be in E.164 format (e.g. +14155551234)');
      return;
    }

    setIsSending(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      if (!token) {
        toast.error('You must be signed in to send a test message');
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            to: testNumber.trim(),
            body: 'Hello from Gatewaze WhatsApp! This is a test message.',
          }),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Test send failed');
      }

      toast.success(`Test message sent (SID: ${result.twilio_sid})`);
    } catch (err) {
      console.error('Test send failed:', err);
      toast.error(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium text-gray-900 dark:text-white">WhatsApp Settings</h3>
          {hasExisting && <CheckCircleIcon className="w-5 h-5 text-green-500" />}
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Configure Twilio credentials for WhatsApp Business messaging.
        </p>
      </div>

      <div className="space-y-4">
        {/* Account SID */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Account SID
          </label>
          <Input
            type="text"
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={config.TWILIO_ACCOUNT_SID}
            onChange={(e) => setConfig((prev) => ({ ...prev, TWILIO_ACCOUNT_SID: e.target.value }))}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Found on the Twilio Console dashboard. May be shared with your SMS module.
          </p>
        </div>

        {/* Auth Token */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Auth Token
          </label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              placeholder="Your Twilio Auth Token"
              value={config.TWILIO_AUTH_TOKEN}
              onChange={(e) => setConfig((prev) => ({ ...prev, TWILIO_AUTH_TOKEN: e.target.value }))}
            />
            <button
              type="button"
              onClick={() => setShowToken((prev) => !prev)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
            >
              {showToken ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* WhatsApp From Number */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            WhatsApp From Number
          </label>
          <Input
            type="text"
            placeholder="+14155238886"
            value={config.WHATSAPP_FROM_NUMBER}
            onChange={(e) => setConfig((prev) => ({ ...prev, WHATSAPP_FROM_NUMBER: e.target.value }))}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Your Twilio WhatsApp sandbox number or approved WhatsApp Business number in E.164 format.
          </p>
        </div>

        {/* Save button */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : hasExisting ? 'Update Settings' : 'Save Settings'}
          </Button>
        </div>

        {/* Test Send */}
        {hasExisting && (
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Test WhatsApp Message
            </h4>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="+14155551234"
                value={testNumber}
                onChange={(e) => setTestNumber(e.target.value)}
                className="flex-1"
              />
              <Button variant="outline" onClick={handleTestSend} disabled={isSending}>
                {isSending ? 'Sending...' : 'Send Test'}
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Send a test WhatsApp message to verify your configuration.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
