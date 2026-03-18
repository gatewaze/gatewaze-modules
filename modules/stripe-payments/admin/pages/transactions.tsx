import { useState, useEffect, useMemo } from 'react';
import { ArrowPathIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
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

import { Button, Card, Input, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { StripeService, StripeTransactionWithRelations } from '@/utils/stripeService';

const columnHelper = createColumnHelper<StripeTransactionWithRelations>();

export default function StripeTransactionsPage() {
  const [transactions, setTransactions] = useState<StripeTransactionWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true },
  ]);

  useEffect(() => {
    loadTransactions();
  }, []);

  const loadTransactions = async () => {
    setLoading(true);
    try {
      const { data, error } = await StripeService.getTransactionsWithRelations();
      if (error) {
        toast.error(error);
      } else {
        setTransactions(data || []);
      }
    } catch (error) {
      toast.error('Failed to load Stripe transactions');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    return {
      total: transactions.length,
      succeeded: transactions.filter(t => t.status === 'succeeded').length,
      processing: transactions.filter(t => t.status === 'processing').length,
      totalAmount: transactions.reduce((sum, t) => sum + t.amount, 0),
      succeededAmount: transactions.filter(t => t.status === 'succeeded').reduce((sum, t) => sum + t.amount, 0),
    };
  }, [transactions]);

  const formatCurrency = (cents: number, currency: string = 'usd') => {
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'succeeded':
        return 'success';
      case 'processing':
        return 'warning';
      case 'requires_payment_method':
      case 'requires_confirmation':
      case 'requires_action':
      case 'requires_capture':
        return 'warning';
      case 'canceled':
        return 'danger';
      default:
        return 'default';
    }
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      'requires_payment_method': 'Requires Payment',
      'requires_confirmation': 'Requires Confirmation',
      'requires_action': 'Requires Action',
      'processing': 'Processing',
      'succeeded': 'Succeeded',
      'canceled': 'Canceled',
      'requires_capture': 'Requires Capture',
    };
    return labels[status] || status;
  };

  const columns = [
    columnHelper.accessor('stripe_payment_intent_id', {
      header: 'Payment Intent',
      cell: (info) => (
        <div className="text-sm font-mono text-[var(--gray-11)]">
          {info.getValue().substring(0, 20)}...
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
    columnHelper.accessor('amount', {
      header: 'Amount',
      cell: (info) => (
        <div className="text-sm font-medium text-[var(--gray-12)]">
          {formatCurrency(info.getValue(), info.row.original.currency)}
        </div>
      ),
    }),
    columnHelper.accessor('payment_method_type', {
      header: 'Payment Method',
      cell: (info) => (
        <div className="text-sm text-[var(--gray-12)] capitalize">
          {info.getValue() || '-'}
        </div>
      ),
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      cell: (info) => (
        <Badge variant={getStatusBadgeVariant(info.getValue())}>
          {getStatusLabel(info.getValue())}
        </Badge>
      ),
    }),
    columnHelper.accessor('invoice', {
      header: 'Invoice',
      cell: (info) => {
        const invoice = info.getValue();
        return invoice?.invoice_number ? (
          <div className="text-sm text-[var(--gray-12)]">
            {invoice.invoice_number}
          </div>
        ) : (
          <span className="text-sm text-[var(--gray-11)]">-</span>
        );
      },
    }),
    columnHelper.accessor('succeeded_at', {
      header: 'Succeeded At',
      cell: (info) => {
        const date = info.getValue();
        return (
          <div className="text-sm text-[var(--gray-12)]">
            {date ? new Date(date).toLocaleDateString() : '-'}
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
  ];

  const table = useReactTable({
    data: transactions,
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
    <Page title="Stripe Transactions">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Stripe Transactions
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              View payment transactions from Stripe
            </p>
          </div>
          <Button
            onClick={loadTransactions}
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
            <div className="text-sm text-[var(--gray-11)]">Total Transactions</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {stats.total}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Successful</div>
            <div className="text-2xl font-bold text-[var(--green-11)]">
              {stats.succeeded}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Processing</div>
            <div className="text-2xl font-bold text-[var(--yellow-11)]">
              {stats.processing}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Collected</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {formatCurrency(stats.succeededAmount)}
            </div>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
            <Input
              type="text"
              placeholder="Search transactions by payment intent or customer..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable table={table} loading={loading} />
      </div>
    </Page>
  );
}
