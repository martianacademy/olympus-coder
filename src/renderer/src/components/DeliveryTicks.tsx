import { Check, CheckCheck } from 'lucide-react';
import { deliveryLabel, type UserDelivery } from '@shared/promptQueue';
import '../promptQueue.css';

/**
 * WhatsApp-style ticks: one grey = saved in Olympus (agent offline / starting), two grey = the agent has it (or is
 * connected and gets it after this turn), two blue = the agent started on it. The tooltip says which.
 */
export function DeliveryTicks({ ticks, seen, label }: { ticks: 1 | 2; seen?: boolean; label: string }) {
  const Icon = ticks === 1 ? Check : CheckCheck;
  return (
    <span className={`delivery-ticks ${seen ? 'seen' : ''}`} title={label} aria-label={label} data-testid="delivery-ticks" data-state={seen ? 'seen' : ticks === 1 ? 'queued' : 'delivered'}>
      <Icon size={14} strokeWidth={2.2} />
    </span>
  );
}

/** Ticks of a sent message (nothing for messages from before delivery was tracked). */
export function SentTicks({ delivery, agentName }: { delivery?: UserDelivery; agentName: string }) {
  if (!delivery) return null;
  return <DeliveryTicks ticks={2} seen={delivery.state === 'seen'} label={deliveryLabel(delivery, agentName)} />;
}
