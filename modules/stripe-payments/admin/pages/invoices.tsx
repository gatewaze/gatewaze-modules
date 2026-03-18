import { useState, useEffect, useMemo } from 'react';
import { ArrowPathIcon, MagnifyingGlassIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';

import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';

import { Button, Card, Input, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { StripeService, StripeInvoiceWithCustomer } from '@/utils/stripeService';

const columnHelper = createColumnHelper<StripeInvoiceWithCustomer>();

export default function StripeInvoicesPage() {
  const [invoices, setInvoices] = useState<StripeInvoiceWithCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true },
  ]);

  useEffect(() => {
    loadInvoices();
  }, []);

  const loadInvoices = async () => {
    setLoading(true);
    try {
      const { data, error } = await StripeService.getInvoicesWithCustomer();
      if (error) {
        toast.error(error);
      } else {
        setInvoices(data || []);
      }
    } catch (error) {
      toast.error('Failed to load Stripe invoices');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    return {
      total: invoices.length,
      paid: invoices.filter(i => i.status === 'paid').length,
      open: invoices.filter(i => i.status === 'open').length,
      totalAmount: invoices.reduce((sum, i) => sum + i.total, 0),
      paidAmount: invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + i.amount_paid, 0),
    };
  }, [invoices]);

  const formatCurrency = (cents: number, currency: string = 'usd') => {
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'paid':
        return 'success';
      case 'open':
        return 'warning';
      case 'draft':
        return 'default';
      case 'void':
      case 'uncollectible':
        return 'danger';
      default:
        return 'default';
    }
  };

  const columns = [
    columnHelper.accessor('invoice_number', {
      header: 'Invoice #',
      cell: (info) => (
        <div className="text-sm font-medium text-[var(--gray-12)]">
          {info.getValue() || 'Draft'}
        </div>
      ),
    }),
    columnHelper.accessor('customer', {
      header: 'Customer',
      cell: (info) => {
        const customer = info.getValue();
        return customer ? (
          <div>
            <div className="text-sm font-medium text-[var(--gray-12)]">
              {customer.name || 'N/A'}
            </div>
            <div className="text-sm text-[var(--gray-11)]">
              {customer.email}
            </div>
          </div>
        ) : (
          <span className="text-sm text-[var(--gray-11)]">Unknown</span>
        );
      },
    }),
    columnHelper.accessor('total', {
      header: 'Amount',
      cell: (info) => (
        <div className="text-sm font-medium text-[var(--gray-12)]">
          {formatCurrency(info.getValue(), info.row.original.currency)}
        </div>
      ),
    }),
    columnHelper.accessor('amount_paid', {
      header: 'Paid',
      cell: (info) => (
        <div className="text-sm font-medium text-[var(--green-11)]">
          {formatCurrency(info.getValue(), info.row.original.currency)}
        </div>
      ),
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      cell: (info) => (
        <Badge variant={getStatusBadgeVariant(info.getValue())}>
          {info.getValue().charAt(0).toUpperCase() + info.getValue().slice(1)}
        </Badge>
      ),
    }),
    columnHelper.accessor('due_date', {
      header: 'Due Date',
      cell: (info) => {
        const dueDate = info.getValue();
        return (
          <div className="text-sm text-[var(--gray-12)]">
            {dueDate ? new Date(dueDate).toLocaleDateString() : '-'}
          </div>
        );
      },
    }),
    columnHelper.accessor('created_at', {
      header: 'Created',
      cell: (info) => (
        <div className="text-sm text-[var(--gray-12)]">
          {new Date(info.getValue()).toLocaleDateString()}
        </div>
      ),
    }),
    columnHelper.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const invoice = info.row.original;
        return (
          <RowActions actions={[
            {
              label: 'View Invoice',
              icon: <ArrowTopRightOnSquareIcon className="size-4" />,
              onClick: () => window.open(invoice.hosted_invoice_url, '_blank'),
              hidden: !invoice.hosted_invoice_url,
            },
          ]} />
        );
      },
    }),
  ];

  const table = useReactTable({
    data: invoices,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: 50,
      },
    },
  });

  return (
    <Page title="Stripe Invoices">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Stripe Invoices
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              View and track invoices from Stripe
            </p>
          </div>
          <Button
            onClick={loadInvoices}
            disabled={loading}
            className="gap-2"
          >
            <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Invoices</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {stats.total}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Paid</div>
            <div className="text-2xl font-bold text-[var(--green-11)]">
              {stats.paid}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Open</div>
            <div className="text-2xl font-bold text-[var(--yellow-11)]">
              {stats.open}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Collected</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {formatCurrency(stats.paidAmount)}
            </div>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
            <Input
              type="text"
              placeholder="Search invoices by invoice number or customer..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable table={table} loading={loading} onRowDoubleClick={(invoice) => invoice.hosted_invoice_url && window.open(invoice.hosted_invoice_url, '_blank')} />
      </div>
    </Page>
  );
}
