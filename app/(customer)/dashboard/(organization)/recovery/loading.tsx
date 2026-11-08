import {Page, PageContent} from "@/features/layout/components/page";
import {RECOVERY} from "@/fork/ui/recovery/labels";

export default function RecoveryLoading() {
    return (
        <Page>
            <PageContent>
                <p role="status" className="text-muted-foreground text-sm">{RECOVERY.page.loading}</p>
                <div aria-hidden="true" className="mt-4 space-y-3">
                    <div className="bg-muted h-8 w-64 animate-pulse rounded motion-reduce:animate-none"/>
                    <div className="bg-muted h-24 w-full animate-pulse rounded motion-reduce:animate-none"/>
                </div>
            </PageContent>
        </Page>
    );
}
