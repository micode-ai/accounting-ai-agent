'use client';

import React, { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, X, Key, Plug } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { profileSchema, type ProfileFormData } from '@/lib/validations/profile';
import { updateProfile } from '@/lib/api/auth';
import { useAuth } from '@/contexts/AuthContext';
import { useLocale, type Locale } from '@/contexts/LocaleContext';
import { ApiError } from '@/lib/api/api-client';

export interface ProfileTranslations {
  title: string;
  description: string;
  firstName: string;
  firstNamePlaceholder: string;
  lastName: string;
  lastNamePlaceholder: string;
  locale: string;
  localePlaceholder: string;
  localeOptions: {
    en: string;
    pl: string;
    ru: string;
  };
  save: string;
  saving: string;
  cancel: string;
  success: string;
  apiCredentials?: string;
  integrations?: string;
}

interface ProfileEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  translations: ProfileTranslations;
  onOpenApiCredentials?: () => void;
}

export function ProfileEditModal({
  open,
  onOpenChange,
  translations,
  onOpenApiCredentials,
}: ProfileEditModalProps) {
  const { user, checkAuth } = useAuth();
  const { setLocale } = useLocale();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      firstName: user?.firstName || '',
      lastName: user?.lastName || '',
      locale: (user?.locale as Locale) || 'en',
    },
  });

  // Reset form when modal opens or user changes
  useEffect(() => {
    if (open && user) {
      reset({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        locale: (user.locale as Locale) || 'en',
      });
      setApiError(null);
      setSuccessMessage(null);
    }
  }, [open, user, reset]);

  const onSubmit = async (data: ProfileFormData) => {
    try {
      setIsSubmitting(true);
      setApiError(null);
      setSuccessMessage(null);

      await updateProfile({
        firstName: data.firstName,
        lastName: data.lastName,
        locale: data.locale,
      });

      // Update locale context
      setLocale(data.locale as Locale);

      // Refresh user data in auth context
      await checkAuth();

      setSuccessMessage(translations.success);

      // Close modal after short delay
      setTimeout(() => {
        onOpenChange(false);
      }, 1500);
    } catch (error) {
      if (error instanceof ApiError) {
        setApiError(error.message);
      } else {
        setApiError('An unexpected error occurred');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const localeOptions = [
    { value: 'en', label: translations.localeOptions.en },
    { value: 'pl', label: translations.localeOptions.pl },
    { value: 'ru', label: translations.localeOptions.ru },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{translations.title}</DialogTitle>
          <DialogDescription>{translations.description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogBody className="space-y-4">
            {/* Success Message */}
            {successMessage && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-green-800">
                  <Check className="h-4 w-4" />
                  <p className="text-sm font-medium">{successMessage}</p>
                </div>
              </div>
            )}

            {/* API Error */}
            {apiError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 text-red-800">
                  <X className="h-4 w-4" />
                  <p className="text-sm font-medium">{apiError}</p>
                </div>
              </div>
            )}

            {/* Locale Select */}
            <div>
              <label
                htmlFor="locale"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {translations.locale}
              </label>
              <Controller
                name="locale"
                control={control}
                render={({ field }) => (
                  <Select
                    id="locale"
                    options={localeOptions}
                    value={field.value}
                    onChange={field.onChange}
                    error={!!errors.locale}
                  />
                )}
              />
              {errors.locale && (
                <p className="mt-1.5 text-sm text-red-600">
                  {errors.locale.message}
                </p>
              )}
            </div>

            {/* First Name */}
            <div>
              <label
                htmlFor="firstName"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {translations.firstName}
              </label>
              <Input
                id="firstName"
                type="text"
                placeholder={translations.firstNamePlaceholder}
                error={!!errors.firstName}
                {...register('firstName')}
              />
              {errors.firstName && (
                <p className="mt-1.5 text-sm text-red-600">
                  {errors.firstName.message}
                </p>
              )}
            </div>

            {/* Last Name */}
            <div>
              <label
                htmlFor="lastName"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {translations.lastName}
              </label>
              <Input
                id="lastName"
                type="text"
                placeholder={translations.lastNamePlaceholder}
                error={!!errors.lastName}
                {...register('lastName')}
              />
              {errors.lastName && (
                <p className="mt-1.5 text-sm text-red-600">
                  {errors.lastName.message}
                </p>
              )}
            </div>

            {/* API Credentials Link */}
            <div className="pt-4 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-3">
              {onOpenApiCredentials && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenApiCredentials();
                  }}
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  <Key className="h-4 w-4" />
                  {translations.apiCredentials || 'Manage API Credentials'}
                </button>
              )}
              <Link
                href="/settings/integrations"
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <Plug className="h-4 w-4" />
                {translations.integrations || 'Integrations'}
              </Link>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {translations.cancel}
            </Button>
            <Button type="submit" loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? translations.saving : translations.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
