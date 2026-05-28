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
import { StripeService, StripeCustomer } from '@/utils/stripeService';

const columnHelper = createColumnHelper<StripeCustomer>();

export default function StripeCustomersPage() {
  const [customers, setCustomers] = useState<StripeCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true },
  ]);

  useEffect(() => {
    loadCustomers();
  }, []);

  const loadCustomers = async () => {
    setLoading(true);
    try {
      const { data, error } = await StripeService.getCustomers();
      if (error) {
        toast.error(error);
      } else {
        setCustomers(data || []);
      }
    } catch (error) {
      toast.error('Failed to load Stripe customers');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    return {
      total: customers.length,
      active: customers.filter(c => c.is_active).length,
      totalBalance: customers.reduce((sum, c) => sum + c.balance, 0),
    };
  }, [customers]);

  const formatCurrency = (cents: number) => {
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    });
  };

  const columns = [
    columnHelper.accessor('name', {
      header: 'Name',
      cell: (info) => (
        <div>
          <div className="text-sm font-medium text-[var(--gray-12)]">
            {info.getValue() || 'N/A'}
          </div>
          <div className="text-sm text-[var(--gray-11)]">
            {info.row.original.email}
          </div>
        </div>
      ),
    }),
    columnHelper.accessor('stripe_customer_id', {
      header: 'Stripe ID',
      cell: (info) => (
        <div className="text-sm font-mono text-[var(--gray-11)]">
          {info.getValue().substring(0, 20)}...
        </div>
      ),
    }),
    columnHelper.accessor('balance', {
      header: 'Balance',
      cell: (info) => (
        <div className={`text-sm font-medium ${info.getValue() < 0 ? 'text-[var(--red-11)]' : 'text-[var(--gray-12)]'}`}>
          {formatCurrency(info.getValue())}
        </div>
      ),
    }),
    columnHelper.accessor('phone', {
      header: 'Phone',
      cell: (info) => (
        <div className="text-sm text-[var(--gray-12)]">
          {info.getValue() || '-'}
        </div>
      ),
    }),
    columnHelper.accessor('is_active', {
      header: 'Status',
      cell: (info) => (
        <Badge variant={info.getValue() ? 'success' : 'default'}>
          {info.getValue() ? 'Active' : 'Inactive'}
        </Badge>
      ),
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
    data: customers,
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
    <Page title="Stripe Customers">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Stripe Customers
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              View and manage customer records from Stripe
            </p>
          </div>
          <Button
            onClick={loadCustomers}
            disabled={loading}
            className="gap-2"
          >
            <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Customers</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {stats.total}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Active Customers</div>
            <div className="text-2xl font-bold text-[var(--green-11)]">
              {stats.active}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Balance</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {formatCurrency(stats.totalBalance)}
            </div>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
            <Input
              type="text"
              placeholder="Search customers by name or email..."
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
