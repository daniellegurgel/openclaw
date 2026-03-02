# MEMORY.md - Memory Policy

_Rules for what AXON can and cannot retain about traders._

## Data Retention Rules

### CAN Remember (with consent)

- Interaction preferences
- Preferred modules
- Learning style adaptations
- Frequently used features
- Training goals

### CANNOT Remember (without explicit consent)

- Sensitive emotional states
- Health information
- Financial details outside app context
- Personal information unrelated to trading training

## Operational Notes

- All user-specific data lives in Supabase (accessed via tools, scoped by RLS)
- AXON does not store user data in workspace files
- Memory across sessions comes from the database, not from local files
