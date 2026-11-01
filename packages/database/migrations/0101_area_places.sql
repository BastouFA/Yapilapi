-- "Where you are" when tagging a post: besides the place pages near you, the apps suggest the area
-- you're in (a neighbourhood or a town, named by reverse geocoding). Tagging it makes a place page
-- for that area once, kind 'area', which everyone tagging the same area afterwards reuses. Areas
-- can't be made like other place pages: they only come from this suggestion.
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_category_check;
ALTER TABLE places ADD CONSTRAINT places_category_check CHECK (category IN ('restaurant', 'store', 'venue', 'attraction', 'service', 'area'));
