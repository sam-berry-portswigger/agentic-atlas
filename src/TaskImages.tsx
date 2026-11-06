import { useEffect, useState } from "react";
import TaskImageViewer from "./TaskImageViewer";
import {
  ActionIcon,
  Button,
  FileButton,
  Group,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { Paperclip, X } from "lucide-react";
export type TaskImage = {
  id?: string;
  name: string;
  data?: string;
  bytes?: number;
  width?: number;
  height?: number;
};
export async function pastedImages(files: File[]): Promise<TaskImage[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<TaskImage>((resolve, reject) => {
          if (file.type !== "image/png" || file.size > 4 * 1024 * 1024) {
            reject(Error("Choose PNG images up to 4 MB each."));
            return;
          }
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name || "Pasted image.png",
              data: String(reader.result).split(",")[1],
              bytes: file.size,
            });
          reader.onerror = () => reject(Error("Couldn’t read the PNG image."));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
export default function TaskImages({
  images,
  taskId,
  onChange,
  onFiles,
  loading = false,
  onAnnotate,
  onViewerChange,
}: {
  images: TaskImage[];
  taskId?: string;
  onChange?: (images: TaskImage[]) => void;
  onFiles?: (files: File[]) => void;
  loading?: boolean;
  onAnnotate?: (image: TaskImage) => Promise<void>;
  onViewerChange?: (open: boolean) => void;
}) {
  const [viewing, setViewing] = useState<TaskImage | null>(null);
  useEffect(() => {
    onViewerChange?.(!!viewing);
    return () => onViewerChange?.(false);
  }, [viewing, onViewerChange]);
  const source = (image: TaskImage) =>
    image.id
      ? `/api/today/tasks/${encodeURIComponent(taskId || "")}/images/${encodeURIComponent(image.id)}`
      : `data:image/png;base64,${image.data}`;
  async function saveCopy(file: File) {
    const [copy] = await pastedImages([file]);
    if (
      images.length >= 4 ||
      images.reduce((total, image) => total + (image.bytes || 0), 0) +
        (copy.bytes || 0) >
        8 * 1024 * 1024
    )
      throw Error(
        "This task has reached its attachment limit (four PNGs, 8 MB total). Remove an attachment before saving a marked-up copy. Your original image is unchanged.",
      );
    if (onChange) onChange([...images, copy]);
    else if (onAnnotate) await onAnnotate(copy);
  }
  if (!images.length && !onChange) return null;
  return (
    <>
      {viewing && (
        <TaskImageViewer
          key={viewing.id || viewing.name}
          src={source(viewing)}
          name={viewing.name}
          onClose={() => setViewing(null)}
          onSave={onChange || onAnnotate ? saveCopy : undefined}
          draft={!!onChange}
        />
      )}
      <Stack gap="xs" mt="md" component="section" aria-label="Task images">
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            Images{images.length ? ` (${images.length})` : ""}
          </Text>
          {onFiles && (
            <FileButton accept="image/png" multiple onChange={onFiles}>
              {(props) => (
                <Button
                  {...props}
                  size="xs"
                  variant="default"
                  loading={loading}
                  leftSection={<Paperclip size={13} />}
                >
                  Attach PNG
                </Button>
              )}
            </FileButton>
          )}
        </Group>
        {onChange && (
          <Text size="xs" c="dimmed">
            Paste a PNG anywhere in this form, or attach a file. Up to 4 images,
            4 MB each.
          </Text>
        )}
        <div className="td-task-images">
          {images.map((image, index) => {
            const src = source(image);
            return (
              <div className="td-task-image" key={image.id || index}>
                <UnstyledButton
                  type="button"
                  className="td-task-image-open"
                  aria-label={`Expand image: ${image.name}`}
                  title="Expand image"
                  onClick={() => setViewing(image)}
                >
                  <img src={src} alt={image.name} />
                </UnstyledButton>
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  <Text size="xs" truncate>
                    {image.name}
                  </Text>
                  {onChange && (
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Remove image: ${image.name}`}
                      onClick={() =>
                        onChange(images.filter((_, i) => i !== index))
                      }
                    >
                      <X size={14} />
                    </ActionIcon>
                  )}
                </Group>
              </div>
            );
          })}
        </div>
      </Stack>
    </>
  );
}
