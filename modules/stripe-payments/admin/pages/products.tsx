import { useState, useEffect, useMemo } from 'react';
import { ArrowPathIcon, MagnifyingGlassIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
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
import { StripeService, StripeProductWithPrices } from '@/utils/stripeService';

const columnHelper = createColumnHelper<StripeProductWithPrices>();

export default function StripeProductsPage() {
  const [products, setProducts] = useState<StripeProductWithPrices[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true },
  ]);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    setLoading(true);
    try {
      const { data, error } = await StripeService.getProductsWithPrices();
      if (error) {
        toast.error(error);
      } else {
        setProducts(data || []);
      }
    } catch (error) {
      toast.error('Failed to load Stripe products');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    return {
      total: products.length,
      active: products.filter(p => p.active).length,
      totalPrices: products.reduce((sum, p) => sum + (p.prices?.length || 0), 0),
    };
  }, [products]);

  const formatCurrency = (cents: number | null | undefined, currency: string = 'usd') => {
    if (cents === null || cents === undefined) return 'Variable';
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
  };

  const columns = [
    columnHelper.accessor('name', {
      header: 'Product Name',
      cell: (info) => (
        <div>
          <div className="text-sm font-medium text-[var(--gray-12)]">
            {info.getValue()}
          </div>
          {info.row.original.description && (
            <div className="text-sm text-[var(--gray-11)] truncate max-w-xs">
              {info.row.original.description}
            </div>
          )}
        </div>
      ),
    }),
    columnHelper.accessor('stripe_product_id', {
      header: 'Stripe ID',
      cell: (info) => (
        <div className="text-sm font-mono text-[var(--gray-11)]">
          {info.getValue().substring(0, 20)}...
        </div>
      ),
    }),
    columnHelper.accessor('prices', {
      header: 'Pricing',
      cell: (info) => {
        const prices = info.getValue();
        if (!prices || prices.length === 0) {
          return <span className="text-sm text-[var(--gray-11)]">No prices</span>;
        }

        const activePrices = prices.filter(p => p.active);
        if (activePrices.length === 0) {
          return <span className="text-sm text-[var(--gray-11)]">No active prices</span>;
        }

        // Show first active price
        const firstPrice = activePrices[0];
        return (
          <div>
            <div className="text-sm font-medium text-[var(--gray-12)]">
              {formatCurrency(firstPrice.unit_amount, firstPrice.currency)}
              {firstPrice.type === 'recurring' && firstPrice.recurring_interval && (
                <span className="text-[var(--gray-11)]">
                  /{firstPrice.recurring_interval}
                </span>
              )}
            </div>
            {activePrices.length > 1 && (
              <div className="text-xs text-[var(--gray-11)]">
                +{activePrices.length - 1} more price{activePrices.length > 2 ? 's' : ''}
              </div>
            )}
          </div>
        );
      },
    }),
    columnHelper.accessor('unit_label', {
      header: 'Unit',
      cell: (info) => (
        <div className="text-sm text-[var(--gray-12)]">
          {info.getValue() || '-'}
        </div>
      ),
    }),
    columnHelper.accessor('active', {
      header: 'Status',
      cell: (info) => (
        <Badge variant={info.getValue() ? 'success' : 'default'}>
          {info.getValue() ? (
            <span className="flex items-center gap-1">
              <CheckCircleIcon className="h-3 w-3" />
              Active
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <XCircleIcon className="h-3 w-3" />
              Inactive
            </span>
          )}
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
    data: products,
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
    <Page title="Stripe Products">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Stripe Products
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              View your product catalog from Stripe
            </p>
          </div>
          <Button
            onClick={loadProducts}
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
            <div className="text-sm text-[var(--gray-11)]">Total Products</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {stats.total}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Active Products</div>
            <div className="text-2xl font-bold text-[var(--green-11)]">
              {stats.active}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-[var(--gray-11)]">Total Price Points</div>
            <div className="text-2xl font-bold text-[var(--gray-12)]">
              {stats.totalPrices}
            </div>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
            <Input
              type="text"
              placeholder="Search products by name or description..."
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
