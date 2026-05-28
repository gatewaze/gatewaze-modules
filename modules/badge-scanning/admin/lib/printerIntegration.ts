/**
 * Brother QL-820NWB Printer Integration
 * Handles printing badges to Brother label printers
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

export interface PrinterConfig {
  printerId: string;
  printerName?: string;
  connectionType: 'usb' | 'network';
  ipAddress?: string;
  port?: number;
  paperSize: '62mm' | '102mm';
}

export interface PrintJob {
  id: string;
  imageBuffer: Buffer;
  config: PrinterConfig;
}

/**
 * Print badge using Brother QL-820NWB printer via IPP (Internet Printing Protocol)
 */
export async function printViaBrotherIPP(
  imageBuffer: Buffer,
  config: PrinterConfig
): Promise<void> {
  if (config.connectionType !== 'network' || !config.ipAddress) {
    throw new Error('IPP printing requires network connection and IP address');
  }

  const ipp = require('ipp');

  const printerUrl = `http://${config.ipAddress}:${config.port || 631}/ipp/print`;
  const printer = ipp.Printer(printerUrl);

  return new Promise((resolve, reject) => {
    const msg = {
      'operation-attributes-tag': {
        'requesting-user-name': 'Event System',
        'job-name': `Badge-${Date.now()}`,
        'document-format': 'image/png',
      },
      data: imageBuffer,
    };

    printer.execute('Print-Job', msg, (err: any, res: any) => {
      if (err) {
        reject(new Error(`Print failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Print badge using system print command (lp/lpr on Unix, print on Windows)
 */
export async function printViaSystemCommand(
  imageBuffer: Buffer,
  config: PrinterConfig
): Promise<void> {
  // Save buffer to temporary file
  const tempDir = '/tmp';
  const tempFile = path.join(tempDir, `badge-${Date.now()}.png`);

  try {
    await fs.writeFile(tempFile, imageBuffer);

    const printerName = config.printerName || config.printerId;

    // Detect OS and use appropriate command
    const platform = process.platform;

    let command: string;
    if (platform === 'darwin' || platform === 'linux') {
      // macOS or Linux - use lp command
      command = `lp -d "${printerName}" -o media=${config.paperSize} -o fit-to-page "${tempFile}"`;
    } else if (platform === 'win32') {
      // Windows - use print command or PowerShell
      command = `powershell -Command "Start-Process -FilePath '${tempFile}' -Verb Print -PassThru | Out-Null"`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    await execAsync(command);
  } finally {
    // Clean up temp file
    try {
      await fs.unlink(tempFile);
    } catch (error) {
      console.error('Failed to delete temp file:', error);
    }
  }
}

/**
 * Print badge using node-printer (direct USB/network printing)
 */
export async function printViaNodePrinter(
  imageBuffer: Buffer,
  config: PrinterConfig
): Promise<void> {
  const printer = require('printer');

  return new Promise((resolve, reject) => {
    printer.printDirect({
      data: imageBuffer,
      printer: config.printerId,
      type: 'RAW',
      success: (jobID: string) => {
        console.log(`Print job ${jobID} sent successfully`);
        resolve();
      },
      error: (err: Error) => {
        reject(new Error(`Print failed: ${err.message}`));
      },
    });
  });
}

/**
 * Get list of available printers
 */
export async function getAvailablePrinters(): Promise<any[]> {
  const printer = require('printer');
  return printer.getPrinters();
}

/**
 * Get default printer
 */
export async function getDefaultPrinter(): Promise<any> {
  const printer = require('printer');
  return printer.getDefaultPrinterName();
}

/**
 * Main print function - tries multiple methods in order of preference
 */
export async function printBadge(
  imageBuffer: Buffer,
  config: PrinterConfig
): Promise<void> {
  // Try IPP first for network printers
  if (config.connectionType === 'network' && config.ipAddress) {
    try {
      await printViaBrotherIPP(imageBuffer, config);
      return;
    } catch (error) {
      console.warn('IPP printing failed, trying alternative method:', error);
    }
  }

  // Try node-printer for USB/local printers
  try {
    await printViaNodePrinter(imageBuffer, config);
    return;
  } catch (error) {
    console.warn('node-printer failed, trying system command:', error);
  }

  // Fallback to system print command
  await printViaSystemCommand(imageBuffer, config);
}

/**
 * Print multiple badges in sequence
 */
export async function printBadgeBatch(
  jobs: PrintJob[]
): Promise<{ successful: number; failed: number; errors: any[] }> {
  const results = {
    successful: 0,
    failed: 0,
    errors: [] as any[],
  };

  for (const job of jobs) {
    try {
      await printBadge(job.imageBuffer, job.config);
      results.successful++;

      // Small delay between prints to prevent printer jams
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      results.failed++;
      results.errors.push({
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Test printer connectivity
 */
export async function testPrinterConnection(config: PrinterConfig): Promise<boolean> {
  try {
    if (config.connectionType === 'network' && config.ipAddress) {
      // Test network connectivity
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const command = process.platform === 'win32'
        ? `ping -n 1 ${config.ipAddress}`
        : `ping -c 1 ${config.ipAddress}`;

      await execAsync(command);
      return true;
    } else {
      // For USB printers, check if it's in the system printer list
      const printers = await getAvailablePrinters();
      return printers.some(p => p.name === config.printerId);
    }
  } catch (error) {
    return false;
  }
}
