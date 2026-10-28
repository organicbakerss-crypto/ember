/**
 * One-click starting categories for an empty world. Nothing is created until
 * the writer picks one; worlds start empty.
 */
export const STARTER_CATEGORIES: { name: string; sections: string[] }[] = [
  { name: 'Characters', sections: ['Overview', 'Appearance', 'Personality', 'History'] },
  { name: 'Places', sections: ['Overview', 'Description', 'History'] },
  { name: 'Lore', sections: ['Overview', 'Details'] },
  { name: 'Factions', sections: ['Overview', 'Members', 'Goals'] },
  { name: 'Items', sections: ['Overview', 'Description', 'History'] },
]
