import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card } from '@/components/ui';
import { toast } from 'sonner';

interface TwilioConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
}

const EMPTY_CONFIG: TwilioConfig = {
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_PHONE_NUMBER: '',
};

export default function TwilioSmsSettings() {
  const [config, setConfig] = useState<TwilioConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testNumber, setTestNumber] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const { data, error } = await supabase
        .from('installed_modules')
        .select('config')
        .eq('id', 'twilio-sms')
        .single();

      if (error) {
        console.error('Failed to load Twilio config:', error);
        return;
      }

      if (data?.config) {
        const saved = data.config as Record<string, string>;
        setConfig({
          TWILIO_ACCOUNT_SID: saved.TWILIO_ACCOUNT_SID ?? '',
          TWILIO_AUTH_TOKEN: saved.TWILIO_AUTH_TOKEN ?? '',
          TWILIO_PHONE_NUMBER: saved.TWILIO_PHONE_NUMBER ?? '',
        });
      }
    } catch (err) {
      console.error('Error loading config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_PHONE_NUMBER) {
      toast.error('All fields are required');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from('installed_modules')
        .update({ config })
        .eq('id', 'twilio-sms');

      if (error) throw error;
      toast.success('Twilio SMS settings saved');
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSend() {
    if (!testNumber) {
      toast.error('Enter a phone number to send a test SMS');
      return;
    }

    if (!/^\+[1-9]\d{1,14}$/.test(testNumber)) {
      toast.error('Phone number must be in E.164 format (e.g. +14155551234)');
      return;
    }

    setSendingTest(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error('Not authenticated');
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sms-send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            to: testNumber,
            body: 'This is a test message from Gatewaze Twilio SMS module.',
            metadata: { type: 'test' },
          }),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to send test SMS');
      }

      toast.success(`Test SMS sent (SID: ${result.twilio_sid})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send test SMS';
      console.error('Test send failed:', err);
      toast.error(message);
    } finally {
      setSendingTest(false);
    }
  }

  function handleChange(field: keyof TwilioConfig, value: string) {
    setConfig((prev) => ({ ...prev, [field]: value }));
  }

  if (loading) {
    return <div className="p-4 text-muted-foreground">Loading Twilio SMS settings...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Twilio SMS Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your Twilio credentials to enable SMS sending for invites and notifications.
        </p>
      </div>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <label htmlFor="twilio-sid" className="text-sm font-medium">
            Account SID
          </label>
          <input
            id="twilio-sid"
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={config.TWILIO_ACCOUNT_SID}
            onChange={(e) => handleChange('TWILIO_ACCOUNT_SID', e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="twilio-token" className="text-sm font-medium">
            Auth Token
          </label>
          <input
            id="twilio-token"
            type="password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Your Twilio Auth Token"
            value={config.TWILIO_AUTH_TOKEN}
            onChange={(e) => handleChange('TWILIO_AUTH_TOKEN', e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="twilio-phone" className="text-sm font-medium">
            Phone Number
          </label>
          <input
            id="twilio-phone"
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="+14155551234"
            value={config.TWILIO_PHONE_NUMBER}
            onChange={(e) => handleChange('TWILIO_PHONE_NUMBER', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Must be in E.164 format (e.g. +14155551234)
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium">Test SMS</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Send a test message to verify your Twilio configuration.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-2">
            <label htmlFor="test-number" className="text-sm font-medium">
              Recipient Number
            </label>
            <input
              id="test-number"
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="+14155551234"
              value={testNumber}
              onChange={(e) => setTestNumber(e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={handleTestSend} disabled={sendingTest}>
            {sendingTest ? 'Sending...' : 'Send Test'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
