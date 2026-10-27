// Shown while the campaign loads, and on the right while research runs. The tiles are the
// same shapes the review card will fill, so the page doesn't jump when it arrives.

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-[color-mix(in_oklab,var(--brand,#a1a1aa)_14%,#f4f4f5)] ${className}`} />;
}

export function ProductTilesSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3" style={{ animationDelay: `${i * 120}ms` }}>
          <SkeletonBlock className="aspect-[3/4] w-full" />
          <SkeletonBlock className="h-4 w-3/4" />
          <SkeletonBlock className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="h-14 border-b" />
      <div className="grid flex-1 grid-cols-[400px_1fr]">
        <div className="space-y-3 border-r p-4">
          <SkeletonBlock className="ml-auto h-10 w-2/3" />
          <SkeletonBlock className="h-24 w-full" />
        </div>
        <div className="space-y-6 p-8">
          <SkeletonBlock className="h-8 w-64" />
          <ProductTilesSkeleton />
        </div>
      </div>
    </div>
  );
}
